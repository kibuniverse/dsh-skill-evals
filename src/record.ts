/**
 * 运行记录构造层：baseRecord 建立一条"未运行"的基线记录，applyAudit 把选择审计并进记录，
 * bodySizes 计算技能正文的 UTF-8 字节数（预算判断以字节而非字符数为准）。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { sutMetadata } from './setup.js'
import type { Dataset } from './dataset.js'
import type { EvalConfig, RunRecord, SelectionCase, TaskCase, AuditRow, SkillFixture } from './types.js'

/**
 * 构造一条基线记录（status='not-run'）；选择器/任务评测在其上逐步回填观测字段。
 * 选择器用例与任务用例共用此结构：'input' in c 区分二者，任务用例的标签字段取中性默认值。
 *
 * 警示：字段顺序是载荷——frozen-config 的 developmentRecordsHash 直接对内存中的记录对象
 * 做 JSON 哈希（不经过 recordSchema parse），因此只允许换行排版，绝不能调整字段顺序。
 */
export async function baseRecord(
  d: Dataset,
  c: SelectionCase | TaskCase,
  config: EvalConfig,
  repeat: number,
): Promise<RunRecord> {
  const meta = await sutMetadata()
  const selector = 'input' in c
  return {
    // —— 标识与调度 ——
    version: 1,
    runId: randomUUID(),
    caseId: c.id,
    family: selector ? c.family : c.id,
    mode: 'synthetic-demo',
    arm: selector ? 'selector' : 'A',
    repeat,
    expectedRepeats: 3,
    split: selector ? c.split : 'task',
    category: selector ? c.category : c.kind,
    // —— 运行状态（由评测过程回填）——
    status: 'not-run',
    failure: null,
    selectionStatus: null,
    selectionFailure: null,
    config,
    sutCommit: meta.commit,
    harnessVersion: meta.harnessVersion,
    catalogHash: d.catalogHash,
    bodyHash: d.bodyHash,
    provider: null,
    model: null,
    typesafeModel: null,
    controlsHash: '',
    submissionObserved: false,
    // —— 判分标签（来自数据集）——
    required: c.required,
    acceptable: selector ? c.acceptable : [],
    forbidden: selector ? c.forbidden : [],
    noSkill: selector ? c.noSkill : false,
    needsHistory: selector ? c.needsHistory : false,
    feasible: (selector ? c.feasible : true) && c.required.length <= config.maxSkills,
    // —— 选择结果（由 applyAudit / 评测回填；existing 恒为 []，但参与全部 coverage 公式）——
    scores: {},
    bodyBytes: {},
    skipped: [],
    existing: [],
    selected: [],
    prepared: [],
    submitted: [],
    supplementalNames: [],
    supplementalLoads: 0,
    // —— 用量、成本与时间 ——
    selectionMs: null,
    wallMs: 0,
    requestBytes: 0,
    injectedBytes: 0,
    typesafeUsage: null,
    mainUsage: null,
    cost: null,
    taskSuccess: null,
    interactionRequired: false,
    timestamp: new Date().toISOString(),
    artifacts: [],
  }
}

/** 把最后一条选择审计并进记录：选择/装载结果、请求字节、耗时、选择模型及其用量与逐技能得分。 */
export function applyAudit(row: RunRecord, audit: AuditRow | undefined) {
  if (!audit) return
  row.selectionStatus = audit.status
  row.selectionFailure = audit.failure ?? null
  row.selected = audit.selected ?? []
  row.prepared = audit.loaded ?? []
  row.skipped = audit.skipped ?? []
  row.requestBytes = audit.requestBytes ?? Buffer.byteLength(JSON.stringify(audit.request))
  row.selectionMs = audit.finishedAt ? audit.finishedAt - audit.startedAt : null
  if (audit.response) {
    row.typesafeModel = audit.response.model
    row.typesafeUsage = {
      input: audit.response.usage.input_tokens,
      output: audit.response.usage.output_tokens,
      cached: 0,
    }
    for (const [id, q] of Object.entries(audit.request.questions))
      if (audit.response.answers[id]) row.scores[q.instructions.skill.name] = audit.response.answers[id]!.noul
  }
}

/** 每个技能按 runtime 形态（目录资源基路径）渲染后的 UTF-8 字节数。 */
export function bodySizes(skills: SkillFixture[], directory: string) {
  return Object.fromEntries(
    skills.map(s => [
      s.name,
      Buffer.byteLength(
        renderSkillContent({
          ...s,
          provider: 'runtime',
          resourceBase: { kind: 'directory', path: join(directory, s.name) },
        }),
        'utf8',
      ),
    ]),
  )
}
