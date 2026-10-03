import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { root, hash } from './io.js'
import type { SkillFixture, SelectionCase, TaskCase } from './types.js'

const skillSchema = z.object({ name: z.string(), description: z.string(), whenToUse: z.string(), content: z.string() })
const caseSchema = z.object({ id: z.string(), family: z.string(), category: z.string(), split: z.enum(['dev', 'holdout']), input: z.string(), required: z.array(z.array(z.string()).min(1)), acceptable: z.array(z.string()), forbidden: z.array(z.string()), noSkill: z.boolean(), needsHistory: z.boolean(), feasible: z.boolean(), adversarialMetadata: z.boolean().optional() })
const taskSchema = z.object({ id: z.string(), kind: z.enum(['fix', 'review', 'csv', 'json', 'report']), prompt: z.string(), files: z.record(z.string(), z.string()), required: z.array(z.array(z.string()).min(1)), grader: z.record(z.string(), z.unknown()) })
export async function loadDataset(): Promise<{ skills: SkillFixture[]; cases: SelectionCase[]; tasks: TaskCase[]; catalogHash: string; bodyHash: string }> {
  const skills = z.array(skillSchema).parse(JSON.parse(await readFile(join(root, 'data/skills.json'), 'utf8')))
  const cases = z.array(caseSchema).parse(JSON.parse(await readFile(join(root, 'data/selection.json'), 'utf8')))
  const tasks = z.array(taskSchema).parse(JSON.parse(await readFile(join(root, 'data/tasks.json'), 'utf8')))
  const names = new Set(skills.map(s => s.name))
  for (const c of [...cases, ...tasks]) for (const group of c.required) for (const n of group) if (!names.has(n)) throw new Error(`Unknown skill ${n} in ${c.id}`)
  const dev = new Set(cases.filter(c => c.split === 'dev').map(c => c.family))
  if (cases.some(c => c.split === 'holdout' && dev.has(c.family))) throw new Error('Task family leaks across splits')
  return { skills, cases, tasks, catalogHash: hash(skills.map(({ content: _content, ...metadata }) => metadata)), bodyHash: hash(skills.map(s => [s.name, s.content])) }
}
