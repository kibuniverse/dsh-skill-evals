import { expect, it } from 'vitest'
import { loadDataset } from '../src/dataset.js'
import { baseRecord } from '../src/record.js'
import { mainUsage } from '../src/captures.js'
import { configSchema } from '../src/types.js'
import { clusteredDifference, costOf, selectionGrade, summarize, percentile, tuning } from '../src/metrics.js'
import { writeReport } from '../src/report.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRecords, saveRecords } from '../src/io.js'

const d = await loadDataset()
const config = configSchema.parse({})
const row = () => baseRecord(d, d.cases[0]!, config, 0)
it('freezes 80 family-separated labels and 20 tasks without leaking answers into prompts', () => {
  expect(d.cases).toHaveLength(80)
  expect(d.tasks).toHaveLength(20)
  expect(d.cases.filter(c => c.split === 'dev')).toHaveLength(40)
  expect(d.cases.filter(c => c.split === 'holdout')).toHaveLength(40)
  const dev = new Set(d.cases.filter(c => c.split === 'dev').map(c => c.family))
  expect(d.cases.filter(c => c.split === 'holdout').some(c => dev.has(c.family))).toBe(false)
  expect(new Set(d.cases.map(c => c.category)).size).toBe(8)
  expect(new Set(d.tasks.map(t => t.kind)).size).toBe(5)
})
it('scores equivalence groups, allowed extras, forbidden extras and empty selections', async () => {
  const r = await row()
  r.required = [['a', 'b'], ['c']]
  r.acceptable = ['d']
  r.forbidden = ['x']
  r.existing = ['c']
  expect(selectionGrade(r, ['b', 'd'])).toEqual({ precision: 1, recall: 1, exact: true })
  expect(selectionGrade(r, ['b', 'x'])).toEqual({ precision: 0.5, recall: 1, exact: false })
  expect(selectionGrade(r, [])).toEqual({ precision: 0, recall: 0.5, exact: false })
  r.required = []
  r.existing = []
  r.noSkill = true
  expect(selectionGrade(r, []).exact).toBe(true)
  expect(selectionGrade(r, ['a']).exact).toBe(false)
})
it('separates infrastructure failures, incomplete repetitions and unobserved submissions', async () => {
  const rows = await Promise.all(Array.from({ length: 3 }, row))
  for (const [i, r] of rows.entries()) {
    r.arm = 'B'
    r.repeat = i
    r.taskSuccess = i < 2 ? true : null
    r.status = i < 2 ? 'passed' : 'infrastructure-failed'
  }
  const summary = summarize(rows).perArm.B!
  expect(summary.successRate).toBe(1)
  expect(summary.endToEndSuccessRate).toBeCloseTo(2 / 3)
  expect(summary.allRepeatsSuccess).toBe(0)
  expect(summarize(rows.slice(0, 2)).perArm.B!.allRepeatsSuccess).toBe(null)
  const selector = await row()
  selector.status = 'passed'
  selector.prepared = selector.required.flat()
  expect(summarize([selector]).selector.preparedCoverage).toBe(1)
  expect(summarize([selector]).selector.submittedCoverage).toBe(null)
})
it('keeps holdout observations out of threshold sweeps and honors count and byte budgets', async () => {
  const a = await row()
  a.status = 'passed'
  a.split = 'dev'
  a.required = [['a'], ['b']]
  a.acceptable = []
  a.scores = { a: 0.95, b: 0.8 }
  a.bodyBytes = { a: 20000, b: 20000 }
  const b = { ...a, split: 'holdout' as const, scores: { a: 0.01, b: 0.01 } }
  const sweep = tuning([a, b])
  expect(sweep).toHaveLength(15)
  expect(sweep.every(s => s.samples === 1)).toBe(true)
  expect(sweep.find(s => s.threshold === 0.75 && s.maxSkills === 3)?.recall).toBe(0.5)
})
it('uses paired task clusters rather than independent trials for B minus A intervals', async () => {
  const rows = []
  for (const id of ['one', 'two'])
    for (const arm of ['A', 'B'] as const)
      for (let i = 0; i < 3; i++) {
        const r = await row()
        r.caseId = id
        r.arm = arm
        r.repeat = i
        r.taskSuccess = arm === 'B'
        rows.push(r)
      }
  expect(clusteredDifference(rows)).toEqual({ estimate: 1, lower95: 1, upper95: 1, pairedTasks: 2 })
  expect(clusteredDifference(rows.filter(r => r.arm === 'B'))).toBe(null)
})
it('normalizes disjoint SDK cached tokens and leaves unpriced usage unknown', async () => {
  const usage = mainUsage([
    {
      type: 'chunk',
      ordinal: 1,
      chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 3 } },
    },
  ])
  expect(usage).toEqual({ input: 35, output: 3, cached: 20 })
  const r = await row()
  r.mainUsage = usage
  expect(costOf(r, null)).toBe(null)
  expect(costOf(r, { typesafeInput: 0, typesafeOutput: 0, mainInput: 1, mainOutput: 2, mainCached: 0.1 })).toBeCloseTo(
    23 / 1e6,
  )
  expect(percentile([9, 1, 5], 0.95)).toBe(9)
})
it('round-trips validated records and produces escaped HTML, JSON and CSV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-report-test-'))
  try {
    const r = await row()
    r.caseId = '<script>alert(1)</script>'
    r.failure = 'comma,"quoted"\nline'
    r.status = 'infrastructure-failed'
    await saveRecords(join(dir, 'records.jsonl'), [r])
    expect(await readRecords(join(dir, 'records.jsonl'))).toEqual([r])
    await writeReport([r], dir)
    const html = await readFile(join(dir, 'index.html'), 'utf8')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('合成数据')
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).summary.count).toBe(1)
    expect(await readFile(join(dir, 'trials.csv'), 'utf8')).toContain('comma,""quoted""')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
