/**
 * report 命令与运行收尾：从既有 records.jsonl 重放报告（不接触 SUT 与网络），
 * 以及供 offline/selector/e2e 共用的"全量记录落盘 + 渲染报告"收尾步骤。
 */
import { resolve } from 'node:path'
import { join } from 'node:path'
import { readRecords, saveRecords } from '../io.js'
import { writeReport } from '../report.js'
import type { RunRecord } from '../types.js'
import type { Flags } from './flags.js'

/** report 命令：--input 指向既有 records.jsonl，产出三种报告文件。 */
export async function runReportCommand(flags: Flags, output: string) {
  if (!flags.input) throw new Error('report requires --input records.jsonl')
  await writeReport(await readRecords(resolve(flags.input)), output)
  console.log(`Report: ${output}/index.html`)
}

/** 运行收尾：把全量记录写回 records.jsonl（逐行过 schema 校验）并渲染报告。 */
export async function writeRunArtifacts(rows: RunRecord[], output: string) {
  await saveRecords(join(output, 'records.jsonl'), rows)
  await writeReport(rows, output)
}
