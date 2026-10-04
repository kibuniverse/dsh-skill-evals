/**
 * e2e 命令：live 端到端对照——每个任务跑 A（无插件）/ B（SUT 插件）/ C（oracle 注入）三臂，
 * 用同一洗牌序执行以摊平时间效应，跑完后校验三臂控制变量一致。
 * 需要 --provider/--model 与 TYPESAFE_API_KEY、DEEPSEEK_API_KEY。
 */
import { join } from 'node:path'
import { z } from 'zod'
import { saveJson, saveRecords } from '../io.js'
import { baseRecord } from '../record.js'
import { evaluateTask } from '../evaluate.js'
import { makeLcg } from '../metrics.js'
import type { RunRecord } from '../types.js'
import { integer, type Flags, type RunContext } from './flags.js'
import { writeRunArtifacts } from './report.js'

/** 确定性洗牌（Fisher–Yates）：与原实现逐位一致，同 seed 复现同一调度序。 */
function shuffled<T>(values: T[], seed: number): T[] {
  const { next } = makeLcg(seed)
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = next() % (i + 1)
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

export async function runE2e(flags: Flags, ctx: RunContext): Promise<RunRecord[]> {
  const { output, config, repeats, d, prices, signal } = ctx
  // 作业展开：任务 × [A,B,C] × repeats，再整体洗牌。
  const jobs = d.tasks
    .slice(0, integer(flags.limit, 20))
    .flatMap(task =>
      ['A', 'B', 'C'].flatMap(arm =>
        Array.from({ length: repeats }, (_, repeat) => ({ task, arm: z.enum(['A', 'B', 'C']).parse(arm), repeat })),
      ),
    )
  const schedule = shuffled(jobs, integer(flags.seed, 20261003))
  await saveJson(
    join(output, 'schedule.json'),
    schedule.map(j => ({ caseId: j.task.id, arm: j.arm, repeat: j.repeat })),
  )
  // 先把全部作业预填为 not-run 行：中断时也能看出缺了哪些。
  const rows: RunRecord[] = []
  for (const job of schedule) {
    const pending = await baseRecord(d, job.task, config, job.repeat)
    pending.mode = 'live-e2e'
    pending.arm = job.arm
    pending.expectedRepeats = repeats
    rows.push(pending)
  }
  await saveRecords(join(output, 'records.jsonl'), rows)
  for (const [index, job] of schedule.entries()) {
    if (signal.aborted) break
    const row = await evaluateTask(
      d,
      job.task,
      config,
      job.arm,
      job.repeat,
      flags.provider!,
      flags.model!,
      prices,
      signal,
    )
    row.expectedRepeats = repeats
    rows[index] = row
    await saveRecords(join(output, 'records.jsonl'), rows)
    console.log(`${index + 1}/${jobs.length} ${job.task.id} ${job.arm}: ${row.status}`)
  }
  // 对照完整性：每个任务各臂的 controlsHash 必须一致；检查遍历全部任务（不止 --limit 切片）。
  for (const task of d.tasks)
    if (new Set(rows.filter(r => r.caseId === task.id && r.status !== 'not-run').map(r => r.controlsHash)).size > 1)
      throw new Error('A/B/C controls differ unexpectedly')
  await writeRunArtifacts(rows, output)
  console.log(`Report: ${output}/index.html`)
  return rows
}
