/**
 * 命令层共享定义：CLI flag 表（parseArgs 选项）、解析结果类型、整数解析工具，
 * 以及各命令共享的运行上下文类型。命令模块只从这里取公共定义，绝不反向 import cli.ts
 * （cli.ts 顶层会执行 parseArgs，被 import 即产生副作用）。
 */
import type { parseArgs } from 'node:util'
import { z } from 'zod'
import type { EvalConfig, Prices } from '../types.js'
import type { Dataset } from '../dataset.js'

/** 全部 CLI 选项（键名即 --flag 名）。 */
export const OPTIONS = {
  'sut-path': { type: 'string' },
  'sut-ref': { type: 'string' },
  output: { type: 'string' },
  input: { type: 'string' },
  split: { type: 'string' },
  repeats: { type: 'string' },
  limit: { type: 'string' },
  seed: { type: 'string' },
  threshold: { type: 'string' },
  'max-skills': { type: 'string' },
  'typesafe-model': { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  prices: { type: 'string' },
  'selection-config': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies NonNullable<Parameters<typeof parseArgs>[0]>['options']

/** 解析后的 flag 值（string 选项为 string，boolean 选项为 boolean；均可能缺省）。 */
export type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string | undefined : boolean | undefined
}

/** 解析数值 flag：缺省用 fallback；非正整数由 zod 报错。 */
export function integer(value: string | undefined, fallback: number) {
  return z
    .number()
    .int()
    .positive()
    .parse(value === undefined ? fallback : Number(value))
}

/** gate 之后各命令共享的已装载上下文（config/repeats/数据集/价格/取消信号）。 */
export interface RunContext {
  output: string
  config: EvalConfig
  repeats: number
  d: Dataset
  prices: Prices | null
  signal: AbortSignal
}
