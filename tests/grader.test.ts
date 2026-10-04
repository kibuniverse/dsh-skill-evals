import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDataset } from '../src/dataset.js'
import { gradeTask } from '../src/grader.js'
const d = await loadDataset()
const fixes = [
  'export function sum(xs) { return xs.reduce((a,b)=>a+b,0); }',
  'export function clamp(x,lo,hi) { return Math.max(lo,Math.min(x,hi)); }',
  'export function unique(xs) { return [...new Set(xs)]; }',
  'export function median(xs) { if(!xs.length)return null; const s=[...xs].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2; }',
]
it.each(d.tasks)('accepts a saved correct artifact and rejects a damaged one for $id', async task => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-grader-test-'))
  try {
    for (const [file, content] of Object.entries(task.files)) await writeFile(join(dir, file), content)
    const file = String(task.grader.file)
    if (task.kind === 'fix') {
      expect((await gradeTask(task, dir)).passed).toBe(false)
      await writeFile(join(dir, file), fixes[Number(task.id.split('-')[1]) - 1]!)
    } else {
      expect((await gradeTask(task, dir)).passed).toBe(false)
      const answer =
        task.kind === 'review'
          ? { bugs: [{ class: task.grader.class, explanation: 'Observed defect causes incorrect boundary behavior.' }] }
          : task.kind === 'json'
            ? {
                valid: task.grader.valid,
                errors: task.grader.valid ? [] : [String(task.grader.field) + ' violates schema'],
              }
            : task.grader.expected
      await writeFile(join(dir, file), JSON.stringify(answer))
    }
    expect(await gradeTask(task, dir)).toMatchObject({ passed: true })
    await writeFile(join(dir, file), 'broken artifact')
    expect((await gradeTask(task, dir)).passed).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
