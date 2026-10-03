import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { TaskCase } from './types.js'
import { scrubEnvironment } from './io.js'

const exec = promisify(execFile)
export async function gradeTask(task: TaskCase, workspace: string): Promise<{ passed: boolean; reason: string }> {
  try {
    const unchanged = typeof task.grader.unchanged === 'string' ? [task.grader.unchanged] : z.array(z.string()).parse(task.grader.unchanged ?? [])
    for (const file of unchanged) if (await readFile(join(workspace, file), 'utf8') !== task.files[file]) return { passed: false, reason: `Changed protected file: ${file}` }
    const file = z.string().parse(task.grader.file)
    if (task.kind === 'fix') {
      // Hidden behavior cases are passed only to the grader process after the agent closes.
      const script = `import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); const spec=JSON.parse(process.argv[2]); const fn=m[spec.function]; if(typeof fn!=='function')process.exit(2); for(const c of spec.checks){const args=structuredClone(c.args); const before=JSON.stringify(args); const got=await fn(...args);if(JSON.stringify(got)!==JSON.stringify(c.expected)||(spec.noMutation&&JSON.stringify(args)!==before))process.exit(1);}`
      await exec(process.execPath, ['--input-type=module', '-e', script, join(workspace, file), JSON.stringify(task.grader)], { cwd: workspace, timeout: 5000, env: scrubEnvironment(false) })
      return { passed: true, reason: 'Hidden behavior checks passed' }
    }
    const value: unknown = JSON.parse(await readFile(join(workspace, file), 'utf8'))
    if (task.kind === 'review') {
      const bugs = z.object({ bugs: z.array(z.object({ class: z.string(), explanation: z.string().min(8) })) }).parse(value).bugs
      const passed = bugs.some(b => b.class === task.grader.class)
      return { passed, reason: passed ? 'Defect class identified; source preserved' : 'Expected defect class not identified' }
    }
    if (task.kind === 'json') {
      const p = z.object({ valid: z.boolean(), errors: z.array(z.string()) }).parse(value)
      const valid = z.boolean().parse(task.grader.valid)
      const passed = p.valid === valid && (valid ? p.errors.length === 0 : p.errors.some(e => e.toLowerCase().includes(String(task.grader.field))))
      return { passed, reason: passed ? 'Validation decision and errors match' : 'Incorrect validation decision or field errors' }
    }
    const equal = (a: unknown, b: unknown): boolean => {
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
      const x = a as Record<string, unknown>; const y = b as Record<string, unknown>
      return Object.keys(x).length === Object.keys(y).length && Object.keys(y).every(k => equal(x[k], y[k]))
    }
    const passed = equal(value, task.grader.expected)
    return { passed, reason: passed ? 'Saved artifact matches expected data' : 'Saved artifact values do not match' }
  } catch { return { passed: false, reason: 'Artifact missing, malformed or behavior check failed' } }
}
