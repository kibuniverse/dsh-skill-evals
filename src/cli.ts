import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { setupSut, DEFAULT_PATH, DEFAULT_REF } from './setup.js'
import { root, saveJson, saveRecords, readRecords, hash } from './io.js'
import { loadDataset } from './dataset.js'
import { configSchema, type RunRecord } from './types.js'
import { baseRecord, bodySizes, evaluateSelector, evaluateTask, readPrices } from './evaluate.js'
import { selectedFromScores } from './metrics.js'
import { writeReport } from './report.js'
import { runSdk, visibleNames, replaySdkSession } from './sdk-runner.js'

const exec = promisify(execFile)
const parsed = parseArgs({ args: process.argv.slice(3), options: {
  'sut-path': { type: 'string' }, 'sut-ref': { type: 'string' },
  output: { type: 'string' }, input: { type: 'string' }, split: { type: 'string' },
  repeats: { type: 'string' }, limit: { type: 'string' }, seed: { type: 'string' },
  threshold: { type: 'string' }, 'max-skills': { type: 'string' },
  'typesafe-model': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  prices: { type: 'string' }, 'selection-config': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} })
const command = process.argv[2]; const flags = parsed.values
function integer(value: string | undefined, fallback: number) { return z.number().int().positive().parse(value === undefined ? fallback : Number(value)) }
function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values]; let state = seed >>> 0
  for (let i = result.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [result[i], result[j]] = [result[j]!, result[i]!] }
  return result
}
async function gate() {
  await setupSut(flags['sut-path'] ?? DEFAULT_PATH, flags['sut-ref'] ?? DEFAULT_REF)
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')])
  const d = await loadDataset(); const config = configSchema.parse({})
  try {
    const smoke = await runSdk({ skills: d.skills, config, arm: 'B', prompt: '修复代码', fixture: true, scores: { 'code-fix': .95 }, provider: 'eval-fixture', model: 'fixture' })
    if (smoke.result.finalResponse !== 'offline-sdk-ok' || !visibleNames(smoke.captures, 'skill-auto-load-typesafe').includes('code-fix') || !smoke.audits.some(a => a.loaded?.includes('code-fix'))) throw new Error('SDK compatibility smoke failed')
    if (!JSON.stringify(await replaySdkSession(smoke.trial, smoke.result.sessionId)).includes(d.skills[0]!.content)) throw new Error('SDK Session persistence failed')
    const compatibility = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(root, 'reports/compatibility.json'), 'utf8')))
    await saveJson(join(root, 'reports/compatibility.json'), { ...compatibility, runtime: 'passed', smokeTrial: smoke.trial })
  } catch (error) {
    const compatibility = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(root, 'reports/compatibility.json'), 'utf8')))
    await saveJson(join(root, 'reports/compatibility.json'), { ...compatibility, runtime: 'failed', error: error instanceof Error ? error.message : 'Runtime gate failed' })
    throw new Error('Runtime compatibility failed; live evaluation blocked. See reports/compatibility.json')
  }
}
async function main() {
  if (flags.help) { console.log('Commands: setup | offline | selector | e2e | report\n--sut-path PATH --sut-ref SHA --input records.jsonl --output DIR\n--split dev|holdout --limit N --repeats N --threshold P --max-skills N\n--typesafe-model VERSION --provider ROUTE --model MODEL --prices prices.json\nLive commands require environment credentials. Offline scores are synthetic demo data.'); return }
  const output = resolve(flags.output ?? join(root, 'reports', command ?? 'offline'))
  if (command === 'report') {
    if (!flags.input) throw new Error('report requires --input records.jsonl')
    await writeReport(await readRecords(resolve(flags.input)), output); console.log(`Report: ${output}/index.html`); return
  }
  if (command === 'selector' && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error('eval:selector requires TYPESAFE_API_KEY; no calls made')
  if (command === 'e2e') {
    if (!flags.provider || !flags.model) throw new Error('eval:e2e requires explicit --provider and --model; no calls made')
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('eval:e2e requires TYPESAFE_API_KEY; no calls made')
    if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('eval:e2e requires DEEPSEEK_API_KEY; no calls made')
  }
  if (!['setup', 'offline', 'selector', 'e2e'].includes(command ?? '')) throw new Error('Unknown command; use --help')
  await gate()
  if (command === 'setup') { console.log('SUT compilation and real SDK-loop compatibility passed (no paid calls).'); return }
  if (command === 'offline' && flags.input) { await writeReport(await readRecords(resolve(flags.input)), output); console.log(`Replay report: ${output}/index.html`); return }
  let config = configSchema.parse({ threshold: flags.threshold === undefined ? .75 : Number(flags.threshold), maxSkills: flags['max-skills'] === undefined ? 3 : Number(flags['max-skills']), model: flags['typesafe-model'] ?? 'jev-latest' })
  const cancellation = new AbortController()
  if (command === 'selector' || command === 'e2e') {
    process.once('SIGINT', () => cancellation.abort(new Error('Caller cancelled')))
    process.once('SIGTERM', () => cancellation.abort(new Error('Caller cancelled')))
  }
  const repeats = integer(flags.repeats, 3); const d = await loadDataset(); const rows: RunRecord[] = []
  const prices = await readPrices(flags.prices)
  if (command === 'selector') {
    const split = flags.split ?? 'dev'
    if (!['dev', 'holdout'].includes(split)) throw new Error('Live selector must use dev or holdout separately')
    if (split === 'holdout' && !flags['selection-config']) throw new Error('Holdout requires --selection-config frozen-config.json from a development run')
    if (flags['selection-config']) {
      if (flags.threshold || flags['max-skills'] || flags['typesafe-model']) throw new Error('Frozen configuration cannot be overridden')
      const frozen = z.object({ config: configSchema, catalogHash: z.string(), bodyHash: z.string(), sourceSplit: z.literal('dev'), developmentRecordsHash: z.string() }).parse(JSON.parse(await readFile(resolve(flags['selection-config']), 'utf8')))
      if (frozen.catalogHash !== d.catalogHash || frozen.bodyHash !== d.bodyHash) throw new Error('Frozen configuration catalog/body hashes differ')
      config = frozen.config
    }
  }
  if (command === 'e2e') {
    const jobs = d.tasks.slice(0, integer(flags.limit, 20)).flatMap(task => ['A', 'B', 'C'].flatMap(arm => Array.from({ length: repeats }, (_, repeat) => ({ task, arm: z.enum(['A', 'B', 'C']).parse(arm), repeat }))))
    const schedule = shuffled(jobs, integer(flags.seed, 20261003))
    await saveJson(join(output, 'schedule.json'), schedule.map(j => ({ caseId: j.task.id, arm: j.arm, repeat: j.repeat })))
    for (const job of schedule) { const pending = await baseRecord(d, job.task, config, job.repeat); pending.mode = 'live-e2e'; pending.arm = job.arm; pending.expectedRepeats = repeats; rows.push(pending) }
    await saveRecords(join(output, 'records.jsonl'), rows)
    for (const [index, job] of schedule.entries()) {
      if (cancellation.signal.aborted) break
      const row = await evaluateTask(d, job.task, config, job.arm, job.repeat, flags.provider!, flags.model!, prices, cancellation.signal)
      row.expectedRepeats = repeats; rows[index] = row; await saveRecords(join(output, 'records.jsonl'), rows)
      console.log(`${index + 1}/${jobs.length} ${job.task.id} ${job.arm}: ${row.status}`)
    }
    for (const task of d.tasks) if (new Set(rows.filter(r => r.caseId === task.id && r.status !== 'not-run').map(r => r.controlsHash)).size > 1) throw new Error('A/B/C controls differ unexpectedly')
  } else {
    const split = flags.split === undefined ? (command === 'selector' ? 'dev' : 'all') : z.enum(['dev', 'holdout', 'all']).parse(flags.split)
    const cases = d.cases.filter(c => split === 'all' || c.split === split).slice(0, integer(flags.limit, 80))
    selectionLoop: for (const c of cases) for (let repeat = 0; repeat < repeats; repeat++) {
      if (cancellation.signal.aborted) break selectionLoop
      if (command === 'selector') rows.push(await evaluateSelector(d, c, config, repeat, prices, cancellation.signal))
      else {
        const row = await baseRecord(d, c, config, repeat)
        row.status = 'passed'; row.failure = null; row.typesafeModel = 'synthetic-demo-not-a-model'
        row.scores = Object.fromEntries(d.skills.map(s => [s.name, c.required.flat().includes(s.name) ? .92 : .08]))
        row.selected = selectedFromScores(row.scores, config.threshold)
        row.bodyBytes = bodySizes(d.skills, '/eval/skills')
        row.prepared = row.selected.slice(0, config.maxSkills); row.injectedBytes = row.prepared.reduce((sum, n) => sum + row.bodyBytes[n]!, 0)
        row.wallMs = 0; rows.push(row)
      }
      rows.at(-1)!.expectedRepeats = repeats
      await saveRecords(join(output, 'records.jsonl'), rows)
    }
    if (command === 'offline') for (const task of d.tasks) for (const arm of ['A', 'B', 'C'] as const) for (let repeat = 0; repeat < repeats; repeat++) {
      const row = await baseRecord(d, task, config, repeat)
      row.expectedRepeats = repeats; row.arm = arm; row.taskSuccess = arm === 'A' ? repeat % 2 === 0 : true; row.status = row.taskSuccess ? 'passed' : 'task-failed'; row.failure = row.taskSuccess ? null : 'Constructed demo failure, not a model observation'; row.controlsHash = hash(task.files); rows.push(row)
    }
  }
  await saveRecords(join(output, 'records.jsonl'), rows); await writeReport(rows, output)
  if (command === 'selector' && (flags.split ?? 'dev') === 'dev') await saveJson(join(output, 'frozen-config.json'), { config, catalogHash: d.catalogHash, bodyHash: d.bodyHash, sourceSplit: 'dev', developmentRecordsHash: hash(rows) })
  console.log(`Report: ${output}/index.html${command === 'offline' ? ' (SYNTHETIC DEMO — not measured performance)' : ''}`)
  if (rows.some(r => r.status === 'infrastructure-failed' || r.status === 'cancelled')) process.exitCode = 2
}
try { await main() } catch (error) { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1 }
