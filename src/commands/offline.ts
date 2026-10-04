/**
 * offline 命令：合成演示运行——不调用任何模型，用构造的分数与任务结果填充记录，
 * 用于验证记录/报告管线本身的正确性。产物带 SYNTHETIC DEMO 标注，不能当作插件效果结论。
 */
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { hash, readRecords, saveRecords } from '../io.js'
import { baseRecord, bodySizes } from '../record.js'
import { selectedFromScores } from '../metrics.js'
import { writeReport } from '../report.js'
import type { RunRecord } from '../types.js'
import { integer, type Flags, type RunContext } from './flags.js'
import { writeRunArtifacts } from './report.js'

/** offline --input：过完 gate 后从既有记录重放报告（校验离线产物可复现）。 */
export async function runOfflineReplay(flags: Flags, output: string) {
  await writeReport(await readRecords(resolve(flags.input!)), output)
  console.log(`Replay report: ${output}/index.html`)
}

export async function runOffline(flags: Flags, ctx: RunContext): Promise<RunRecord[]> {
  const { output, config, repeats, d } = ctx
  const split = flags.split === undefined ? 'all' : z.enum(['dev', 'holdout', 'all']).parse(flags.split)
  const cases = d.cases.filter(c => split === 'all' || c.split === split).slice(0, integer(flags.limit, 80))
  const rows: RunRecord[] = []
  // 合成选择行：required 里的技能给 .92、其余给 .08，选择/准备按 config 推导。
  // 逐轮即时落盘，保证中断时已评测的行不丢失。
  for (const c of cases)
    for (let repeat = 0; repeat < repeats; repeat++) {
      const row = await baseRecord(d, c, config, repeat)
      row.status = 'passed'
      row.failure = null
      row.typesafeModel = 'synthetic-demo-not-a-model'
      row.scores = Object.fromEntries(d.skills.map(s => [s.name, c.required.flat().includes(s.name) ? 0.92 : 0.08]))
      row.selected = selectedFromScores(row.scores, config.threshold)
      row.bodyBytes = bodySizes(d.skills, '/eval/skills')
      row.prepared = row.selected.slice(0, config.maxSkills)
      row.injectedBytes = row.prepared.reduce((sum, n) => sum + row.bodyBytes[n]!, 0)
      row.wallMs = 0
      rows.push(row)
      rows.at(-1)!.expectedRepeats = repeats
      await saveRecords(join(output, 'records.jsonl'), rows)
    }
  // 合成任务行：A 臂按 repeat 奇偶交替成败、B/C 恒成功，仅为演示失败路径的报告形态。
  for (const task of d.tasks)
    for (const arm of ['A', 'B', 'C'] as const)
      for (let repeat = 0; repeat < repeats; repeat++) {
        const row = await baseRecord(d, task, config, repeat)
        row.expectedRepeats = repeats
        row.arm = arm
        row.taskSuccess = arm === 'A' ? repeat % 2 === 0 : true
        row.status = row.taskSuccess ? 'passed' : 'task-failed'
        row.failure = row.taskSuccess ? null : 'Constructed demo failure, not a model observation'
        row.controlsHash = hash(task.files)
        rows.push(row)
      }
  await writeRunArtifacts(rows, output)
  console.log(`Report: ${output}/index.html (SYNTHETIC DEMO — not measured performance)`)
  return rows
}
