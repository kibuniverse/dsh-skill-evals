/**
 * 捕获与分析层：读取并理解 SDK 子进程落盘的观测数据。
 *
 * 覆盖三类数据：
 * - requests.jsonl 的捕获行（request / chunk / budget），由 runtime-plugin 的 llm/stream 钩子写入；
 * - SUT 插件写进存储域的选择审计行（readAudits 递归收集并按请求去重）；
 * - 从捕获行 / 会话事件中提取的派生事实（可见技能名、主模型用量、补充加载）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { hash } from './io.js'
import type { AuditRow } from './types.js'

/** 一次主模型请求的捕获（时间戳仅落盘、不参与类型，避免被误当作稳定字段）。 */
export interface CaptureRequest {
  type: 'request'
  ordinal: number
  provider: string
  model: string
  maxTokens?: number
  purpose: string | null
  messages: unknown[]
  tools?: unknown[]
}
/** usage / finish 事件块的捕获。 */
export interface CaptureChunk {
  type: 'chunk'
  ordinal: number
  chunk:
    | {
        type: 'usage'
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      }
    | { type: 'finish'; reason: { kind: string } }
}
/** 预算触顶标记（请求上限或输出 token 上限）。 */
export type CaptureBudget = { type: 'budget'; reason: string }
export type Capture = CaptureBudget | CaptureRequest | CaptureChunk

/** 严格读取捕获文件：文件缺失或任何一行损坏都会抛错（runSdk 成功路径使用——数据必须完整）。 */
export async function readCapturesStrict(path: string): Promise<Capture[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Capture)
}

/** 宽容读取捕获文件：文件缺失按空处理、损坏行直接跳过（失败诊断路径使用——诊断数据本身可能不完整）。 */
export async function readCapturesLenient(path: string): Promise<Capture[]> {
  return (await readFile(path, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Capture]
      } catch {
        return []
      }
    })
}

/** 递归收集目录下所有 JSON 文件中的审计行，按 (startedAt, request) 哈希去重并保持出现顺序。 */
export async function readAudits(path: string): Promise<AuditRow[]> {
  const rows: AuditRow[] = []
  async function walk(dir: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (file.endsWith('.json')) {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'))
        // 审计行可能嵌在更大的对象里，递归查找带 request/status/startedAt 的节点。
        const collect = (v: unknown) => {
          if (!v || typeof v !== 'object') return
          if ('request' in v && 'status' in v && 'startedAt' in v) rows.push(v as AuditRow)
          else for (const child of Object.values(v)) collect(child)
        }
        collect(value)
      }
    }
  }
  await walk(path)
  return [...new Map(rows.map(r => [hash([r.startedAt, r.request]), r])).values()]
}

/** 提取所有请求消息里以指定 source.kind 标记的技能名（去重保序）。 */
export function visibleNames(captures: Capture[], sourceKind: string) {
  const schema = z.object({ source: z.object({ kind: z.string(), name: z.string().optional() }) })
  return [
    ...new Set(
      captures.flatMap(c =>
        c.type === 'request'
          ? c.messages.flatMap(m => {
              const p = schema.safeParse(m)
              return p.success && p.data.source.kind === sourceKind && p.data.source.name ? [p.data.source.name] : []
            })
          : [],
      ),
    ),
  ]
}

/** 汇总主模型用量：把每次 usage 块累加，缓存读写计入 input；没有任何 usage 块时返回 null（用量未知）。 */
export function mainUsage(captures: Capture[]) {
  const usage = { input: 0, output: 0, cached: 0 }
  let found = false
  for (const c of captures)
    if (c.type === 'chunk' && c.chunk.type === 'usage') {
      found = true
      const u = c.chunk.usage
      usage.input += u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      usage.output += u.outputTokens
      usage.cached += u.cacheReadTokens ?? 0
    }
  return found ? usage : null
}

/**
 * 原生模型的 `skill` 工具调用产生的是 tool 消息而非用户 skill-invocation 消息，
 * 所以补充加载要从 assistant 的 tool-call + 对应 tool/result 是否成功推断。
 */
export function supplementalSkills(events: { type: string; data: unknown }[]) {
  const calls = new Map<string, string>()
  const loaded: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const p = z.object({ message: z.object({ content: z.array(z.unknown()) }) }).safeParse(event.data)
      if (!p.success) continue
      for (const block of p.data.message.content) {
        const call = z
          .object({ type: z.literal('tool-call'), id: z.string(), name: z.literal('skill'), arguments: z.string() })
          .safeParse(block)
        if (!call.success) continue
        try {
          const args = z.object({ name: z.string() }).parse(JSON.parse(call.data.arguments))
          calls.set(call.data.id, args.name)
        } catch {
          /* 参数损坏的工具调用不算成功加载 */
        }
      }
    }
    if (event.type === 'tool/result') {
      const p = z
        .object({ message: z.object({ toolCallId: z.string(), isError: z.boolean().optional() }) })
        .safeParse(event.data)
      if (p.success && !p.data.message.isError && calls.has(p.data.message.toolCallId))
        loaded.push(calls.get(p.data.message.toolCallId)!)
    }
  }
  return loaded
}

/** 从捕获的请求消息中回放补充加载（assistant/tool 消息重组为事件后复用 supplementalSkills）。 */
export function submittedSupplementalSkills(captures: Capture[]) {
  return [
    ...new Set(
      captures.flatMap(c => {
        if (c.type !== 'request') return []
        const events = c.messages.flatMap(message => {
          const p = z.object({ role: z.string() }).safeParse(message)
          if (!p.success || !['assistant', 'tool'].includes(p.data.role)) return []
          return [{ type: p.data.role === 'assistant' ? 'assistant/message' : 'tool/result', data: { message } }]
        })
        return supplementalSkills(events)
      }),
    ),
  ]
}
