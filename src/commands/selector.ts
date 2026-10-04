/**
 * selector 命令：live 选择评测——80 个种子用例逐个驱动真实 TypeSafe 选择器（无主模型请求）。
 * dev 与 holdout 必须分开跑：dev 跑完产出 frozen-config.json；holdout 只能用该冻结配置跑
 * （防止用保留集调参）。需要 TYPESAFE_API_KEY。
 */
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { hash, saveJson, saveRecords } from '../io.js'
import { evaluateSelector } from '../evaluate.js'
import { configSchema, type RunRecord } from '../types.js'
import { integer, type Flags, type RunContext } from './flags.js'
import { writeRunArtifacts } from './report.js'

/** frozen-config.json 的封装 schema：配置 + 数据集指纹 + 来源 split + 开发集记录哈希。 */
const frozenSchema = z.object({
  config: configSchema,
  catalogHash: z.string(),
  bodyHash: z.string(),
  sourceSplit: z.literal('dev'),
  developmentRecordsHash: z.string(),
})

export async function runSelector(flags: Flags, ctx: RunContext): Promise<RunRecord[]> {
  const { output, repeats, d, prices, signal } = ctx
  let config = ctx.config
  // split 与 frozen-config 规则：任何违规都在发出第一个评测请求前抛出。
  const split = flags.split ?? 'dev'
  if (!['dev', 'holdout'].includes(split)) throw new Error('Live selector must use dev or holdout separately')
  if (split === 'holdout' && !flags['selection-config'])
    throw new Error('Holdout requires --selection-config frozen-config.json from a development run')
  if (flags['selection-config']) {
    if (flags.threshold || flags['max-skills'] || flags['typesafe-model'])
      throw new Error('Frozen configuration cannot be overridden')
    const frozen = frozenSchema.parse(JSON.parse(await readFile(resolve(flags['selection-config']), 'utf8')))
    if (frozen.catalogHash !== d.catalogHash || frozen.bodyHash !== d.bodyHash)
      throw new Error('Frozen configuration catalog/body hashes differ')
    config = frozen.config
  }
  // 校验后 split 只可能是 dev/holdout；逐轮即时落盘，保证中断时已评测的行不丢失。
  const cases = d.cases.filter(c => c.split === split).slice(0, integer(flags.limit, 80))
  const rows: RunRecord[] = []
  selectionLoop: for (const c of cases)
    for (let repeat = 0; repeat < repeats; repeat++) {
      if (signal.aborted) break selectionLoop
      rows.push(await evaluateSelector(d, c, config, repeat, prices, signal))
      rows.at(-1)!.expectedRepeats = repeats
      await saveRecords(join(output, 'records.jsonl'), rows)
    }
  await writeRunArtifacts(rows, output)
  // dev 运行结束即冻结配置：记录当前 config 与数据集指纹，供 holdout 复用。
  if (split === 'dev')
    await saveJson(join(output, 'frozen-config.json'), {
      config,
      catalogHash: d.catalogHash,
      bodyHash: d.bodyHash,
      sourceSplit: 'dev',
      developmentRecordsHash: hash(rows),
    })
  console.log(`Report: ${output}/index.html`)
  return rows
}
