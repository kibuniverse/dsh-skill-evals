/**
 * 判分层：任务结束后对工作区做确定性判分（模型不参与、不看到判分细节）。
 * fix 类的隐藏行为检查只把规格交给一个一次性 node 子进程执行，判分逻辑永不进入提示词。
 * 任何异常（文件缺失/格式损坏/子进程失败）统一记为不通过，不区分原因——与原行为一致。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { TaskCase } from './types.js'
import { scrubEnvironment } from './io.js'

const exec = promisify(execFile)

/**
 * 隐藏行为检查脚本（在子进程里 import 选手保存的模块并逐用例比对）：
 * 校验函数存在（exit 2）、输出与期望逐例相等（exit 1）、noMutation 时参数不得被改动。
 */
const BEHAVIOR_CHECK_SCRIPT = `import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); const spec=JSON.parse(process.argv[2]); const fn=m[spec.function]; if(typeof fn!=='function')process.exit(2); for(const c of spec.checks){const args=structuredClone(c.args); const before=JSON.stringify(args); const got=await fn(...args);if(JSON.stringify(got)!==JSON.stringify(c.expected)||(spec.noMutation&&JSON.stringify(args)!==before))process.exit(1);}`

/** fix：把判分规格交给子进程执行隐藏行为检查（用例只给判分器，不给模型）。 */
async function gradeFix(task: TaskCase, workspace: string, file: string) {
  await exec(
    process.execPath,
    ['--input-type=module', '-e', BEHAVIOR_CHECK_SCRIPT, join(workspace, file), JSON.stringify(task.grader)],
    { cwd: workspace, timeout: 5000, env: scrubEnvironment(false) },
  )
  return { passed: true, reason: 'Hidden behavior checks passed' }
}

/** review：识别的缺陷类别需命中期望类别，且给出实质解释。 */
function gradeReview(value: unknown, task: TaskCase) {
  const bugs = z
    .object({ bugs: z.array(z.object({ class: z.string(), explanation: z.string().min(8) })) })
    .parse(value).bugs
  const passed = bugs.some(b => b.class === task.grader.class)
  return {
    passed,
    reason: passed ? 'Defect class identified; source preserved' : 'Expected defect class not identified',
  }
}

/** json：校验决策（valid）须正确，且错误列表指认期望字段。 */
function gradeJson(value: unknown, task: TaskCase) {
  const p = z.object({ valid: z.boolean(), errors: z.array(z.string()) }).parse(value)
  const valid = z.boolean().parse(task.grader.valid)
  const passed =
    p.valid === valid &&
    (valid ? p.errors.length === 0 : p.errors.some(e => e.toLowerCase().includes(String(task.grader.field))))
  return {
    passed,
    reason: passed ? 'Validation decision and errors match' : 'Incorrect validation decision or field errors',
  }
}

/** 深比较：对象按键逐一递归（键序不敏感），数组退化为 JSON 字符串比较（保序）。 */
function equal(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return Object.keys(x).length === Object.keys(y).length && Object.keys(y).every(k => equal(x[k], y[k]))
}

/** csv/report：保存的产物须与期望数据完全一致。 */
function gradeArtifact(value: unknown, task: TaskCase) {
  const passed = equal(value, task.grader.expected)
  return { passed, reason: passed ? 'Saved artifact matches expected data' : 'Saved artifact values do not match' }
}

export async function gradeTask(task: TaskCase, workspace: string): Promise<{ passed: boolean; reason: string }> {
  try {
    // 保护文件不得被改动。
    const unchanged =
      typeof task.grader.unchanged === 'string'
        ? [task.grader.unchanged]
        : z.array(z.string()).parse(task.grader.unchanged ?? [])
    for (const file of unchanged)
      if ((await readFile(join(workspace, file), 'utf8')) !== task.files[file])
        return { passed: false, reason: `Changed protected file: ${file}` }
    const file = z.string().parse(task.grader.file)
    if (task.kind === 'fix') return await gradeFix(task, workspace, file)
    const value: unknown = JSON.parse(await readFile(join(workspace, file), 'utf8'))
    if (task.kind === 'review') return gradeReview(value, task)
    if (task.kind === 'json') return gradeJson(value, task)
    return gradeArtifact(value, task)
  } catch {
    return { passed: false, reason: 'Artifact missing, malformed or behavior check failed' }
  }
}
