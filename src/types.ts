/**
 * 类型与 schema 的单一事实来源：数据集装载契约、运行配置、运行记录与价格表全部集中在此。
 *
 * 警示：zod schema 的键序是"载荷"（load-bearing），绝不能调整——
 * - recordSchema 的键序决定 records.jsonl 每行的字节顺序（saveRecords 写盘前会把记录重新 parse 一遍，
 *   zod 按 schema 键序重建对象并剥除未知键）；
 * - skillSchema 的键序参与 catalogHash 哈希计算。
 * 迁移属性时只能逐字复制，禁止重排。
 */
import { z } from 'zod'

// —— 数据集 schema：data/skills.json / data/selection.json / data/tasks.json 的装载契约 ——

/** 技能目录条目：名字、描述与完整正文。 */
export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  content: z.string(),
})

/** 选择评测用例：一段用户输入，以及期望被选中的技能集合标签。 */
export const caseSchema = z.object({
  id: z.string(),
  family: z.string(),
  category: z.string(),
  split: z.enum(['dev', 'holdout']),
  input: z.string(),
  required: z.array(z.array(z.string()).min(1)),
  acceptable: z.array(z.string()),
  forbidden: z.array(z.string()),
  noSkill: z.boolean(),
  needsHistory: z.boolean(),
  feasible: z.boolean(),
  adversarialMetadata: z.boolean().optional(),
})

/** 端到端任务：工作区文件 + 提示词 + 判分器配置。 */
export const taskSchema = z.object({
  id: z.string(),
  kind: z.enum(['fix', 'review', 'csv', 'json', 'report']),
  prompt: z.string(),
  files: z.record(z.string(), z.string()),
  required: z.array(z.array(z.string()).min(1)),
  grader: z.record(z.string(), z.unknown()),
})

export type SkillFixture = z.output<typeof skillSchema>
export type SelectionCase = z.output<typeof caseSchema>
export type TaskCase = z.output<typeof taskSchema>

// —— 运行配置 ——

/** 评测运行配置；frozen-config.json 中冻结的就是这份配置。strict：拒绝未知键。 */
export const configSchema = z
  .object({
    threshold: z.number().min(0).max(1).default(0.75),
    maxSkills: z.number().int().positive().default(3),
    timeoutMs: z.number().int().positive().default(5000),
    maxInjectedBytes: z.number().int().positive().default(32768),
    maxInputBytes: z.number().int().positive().default(65536),
    model: z.string().min(1).default('jev-latest'),
    maxRetries: z.literal(0).default(0),
  })
  .strict()
export type EvalConfig = z.output<typeof configSchema>

// —— 运行记录：每条记录对应一次评测观测，是 records.jsonl 的行格式 ——

const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cached: z.number().nonnegative().default(0),
})
export const recordSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  caseId: z.string(),
  family: z.string(),
  mode: z.enum(['synthetic-demo', 'replay', 'live-selector', 'live-e2e']),
  arm: z.enum(['selector', 'A', 'B', 'C']),
  repeat: z.number().int().nonnegative(),
  expectedRepeats: z.number().int().positive().default(3),
  split: z.enum(['dev', 'holdout', 'task']),
  category: z.string(),
  status: z.enum(['passed', 'task-failed', 'infrastructure-failed', 'cancelled', 'not-run']),
  failure: z.string().nullable(),
  selectionStatus: z.string().nullable().default(null),
  selectionFailure: z.string().nullable().default(null),
  config: configSchema,
  sutCommit: z.string(),
  harnessVersion: z.string(),
  catalogHash: z.string(),
  bodyHash: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  typesafeModel: z.string().nullable().default(null),
  controlsHash: z.string().default(''),
  submissionObserved: z.boolean().default(false),
  required: z.array(z.array(z.string())),
  acceptable: z.array(z.string()),
  forbidden: z.array(z.string()),
  noSkill: z.boolean(),
  needsHistory: z.boolean(),
  feasible: z.boolean(),
  scores: z.record(z.string(), z.number().min(0).max(1)),
  bodyBytes: z.record(z.string(), z.number().nonnegative()).default({}),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  existing: z.array(z.string()),
  selected: z.array(z.string()),
  prepared: z.array(z.string()),
  submitted: z.array(z.string()),
  supplementalNames: z.array(z.string()).default([]),
  supplementalLoads: z.number().int().nonnegative(),
  selectionMs: z.number().nonnegative().nullable(),
  wallMs: z.number().nonnegative(),
  requestBytes: z.number().nonnegative(),
  injectedBytes: z.number().nonnegative(),
  typesafeUsage: usageSchema.nullable(),
  mainUsage: usageSchema.nullable(),
  cost: z.number().nonnegative().nullable(),
  taskSuccess: z.boolean().nullable(),
  interactionRequired: z.boolean(),
  timestamp: z.string(),
  artifacts: z.array(z.string()),
})
export type RunRecord = z.output<typeof recordSchema>

// —— 价格表（--prices，单位：每百万 token 的货币数）——

export const pricesSchema = z
  .object({
    typesafeInput: z.number().nonnegative(),
    typesafeOutput: z.number().nonnegative(),
    mainInput: z.number().nonnegative(),
    mainOutput: z.number().nonnegative(),
    mainCached: z.number().nonnegative(),
  })
  .strict()
export type Prices = z.output<typeof pricesSchema>

// —— 手写类型：描述外部产生的 JSON，从不经过 zod parse ——

/**
 * 选择器审计行：由 SUT 插件写入存储域（.work/<trial>/home/storages 或组件工作区）。
 * 只覆盖本仓库实际消费的字段，结构可能比这里描述的更丰富。
 */
export interface AuditRow {
  request: {
    model: string
    state: { userInput: string }
    questions: Record<string, { instructions: { skill: { name: string } } }>
  }
  response?: {
    model: string
    answers: Record<string, { noul: number }>
    usage: { input_tokens: number; output_tokens: number }
  }
  selected?: string[]
  loaded?: string[]
  skipped?: { name: string; reason: string }[]
  status: string
  requestBytes?: number
  startedAt: number
  finishedAt?: number
  failure?: string
}
