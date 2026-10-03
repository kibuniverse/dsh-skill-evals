import { z } from 'zod'

export interface SkillFixture { name: string; description: string; whenToUse: string; content: string }
export interface SelectionCase {
  id: string; family: string; category: string; split: 'dev' | 'holdout'; input: string
  required: string[][]; acceptable: string[]; forbidden: string[]
  noSkill: boolean; needsHistory: boolean; feasible: boolean; adversarialMetadata?: boolean | undefined
}
export interface TaskCase {
  id: string; kind: 'fix' | 'review' | 'csv' | 'json' | 'report'; prompt: string
  files: Record<string, string>; required: string[][]; grader: Record<string, unknown>
}
export const configSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.75),
  maxSkills: z.number().int().positive().default(3),
  timeoutMs: z.number().int().positive().default(5000),
  maxInjectedBytes: z.number().int().positive().default(32768),
  maxInputBytes: z.number().int().positive().default(65536),
  model: z.string().min(1).default('jev-latest'),
  maxRetries: z.literal(0).default(0),
}).strict()
export type EvalConfig = z.output<typeof configSchema>
const usageSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cached: z.number().nonnegative().default(0) })
export const recordSchema = z.object({
  version: z.literal(1), runId: z.string(), caseId: z.string(), family: z.string(),
  mode: z.enum(['synthetic-demo', 'replay', 'live-selector', 'live-e2e']),
  arm: z.enum(['selector', 'A', 'B', 'C']), repeat: z.number().int().nonnegative(),
  expectedRepeats: z.number().int().positive().default(3),
  split: z.enum(['dev', 'holdout', 'task']), category: z.string(),
  status: z.enum(['passed', 'task-failed', 'infrastructure-failed', 'cancelled', 'not-run']),
  failure: z.string().nullable(), selectionStatus: z.string().nullable().default(null), selectionFailure: z.string().nullable().default(null), config: configSchema,
  sutCommit: z.string(), harnessVersion: z.string(), catalogHash: z.string(), bodyHash: z.string(),
  provider: z.string().nullable(), model: z.string().nullable(),
  typesafeModel: z.string().nullable().default(null), controlsHash: z.string().default(''), submissionObserved: z.boolean().default(false),
  required: z.array(z.array(z.string())), acceptable: z.array(z.string()), forbidden: z.array(z.string()),
  noSkill: z.boolean(), needsHistory: z.boolean(), feasible: z.boolean(),
  scores: z.record(z.string(), z.number().min(0).max(1)),
  bodyBytes: z.record(z.string(), z.number().nonnegative()).default({}),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  existing: z.array(z.string()), selected: z.array(z.string()), prepared: z.array(z.string()),
  submitted: z.array(z.string()), supplementalNames: z.array(z.string()).default([]), supplementalLoads: z.number().int().nonnegative(),
  selectionMs: z.number().nonnegative().nullable(), wallMs: z.number().nonnegative(),
  requestBytes: z.number().nonnegative(), injectedBytes: z.number().nonnegative(),
  typesafeUsage: usageSchema.nullable(), mainUsage: usageSchema.nullable(),
  cost: z.number().nonnegative().nullable(), taskSuccess: z.boolean().nullable(),
  interactionRequired: z.boolean(), timestamp: z.string(),
  artifacts: z.array(z.string()),
})
export type RunRecord = z.output<typeof recordSchema>
export interface Prices { typesafeInput: number; typesafeOutput: number; mainInput: number; mainOutput: number; mainCached: number }
export interface AuditRow {
  request: { model: string; state: { userInput: string }; questions: Record<string, { instructions: { skill: { name: string } } }> }
  response?: { model: string; answers: Record<string, { noul: number }>; usage: { input_tokens: number; output_tokens: number } }
  selected?: string[]; loaded?: string[]; skipped?: { name: string; reason: string }[]
  status: string; requestBytes?: number; startedAt: number; finishedAt?: number; failure?: string
}
