/**
 * 数据集装载层：读取并校验 data/ 下的种子数据（技能目录、选择用例、端到端任务），
 * 计算目录/正文指纹（catalogHash / bodyHash，用于冻结配置与控制变量校验），
 * 另提供 --prices 价格表装载（未提供时返回 null，费用指标记为未知）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { root, hash } from './io.js'
import {
  skillSchema,
  caseSchema,
  taskSchema,
  pricesSchema,
  type SkillFixture,
  type SelectionCase,
  type TaskCase,
  type Prices,
} from './types.js'

/** 装载完成的数据集：三份数据加上两个指纹哈希。 */
export interface Dataset {
  skills: SkillFixture[]
  cases: SelectionCase[]
  tasks: TaskCase[]
  catalogHash: string
  bodyHash: string
}

export async function loadDataset(): Promise<Dataset> {
  const skills = z.array(skillSchema).parse(JSON.parse(await readFile(join(root, 'data/skills.json'), 'utf8')))
  const cases = z.array(caseSchema).parse(JSON.parse(await readFile(join(root, 'data/selection.json'), 'utf8')))
  const tasks = z.array(taskSchema).parse(JSON.parse(await readFile(join(root, 'data/tasks.json'), 'utf8')))
  // 一致性校验：required 里引用的技能必须存在；holdout 用例的 family 不得与 dev 重叠（防标签泄漏）。
  const names = new Set(skills.map(s => s.name))
  for (const c of [...cases, ...tasks])
    for (const group of c.required)
      for (const n of group) if (!names.has(n)) throw new Error(`Unknown skill ${n} in ${c.id}`)
  const dev = new Set(cases.filter(c => c.split === 'dev').map(c => c.family))
  if (cases.some(c => c.split === 'holdout' && dev.has(c.family))) throw new Error('Task family leaks across splits')
  return {
    skills,
    cases,
    tasks,
    catalogHash: hash(skills.map(({ content: _content, ...metadata }) => metadata)),
    bodyHash: hash(skills.map(s => [s.name, s.content])),
  }
}

/** 读取价格表；path 未提供时返回 null（所有费用指标将记为 null/未知）。 */
export async function readPrices(path: string | undefined): Promise<Prices | null> {
  if (!path) return null
  return pricesSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
