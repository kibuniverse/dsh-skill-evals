import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { root, saveJson, scrubEnvironment, hash } from './io.js'
import { sutRoot } from './setup.js'
import type { EvalConfig, SkillFixture, AuditRow } from './types.js'

export interface CaptureRequest { type: 'request'; ordinal: number; provider: string; model: string; maxTokens?: number; purpose: string | null; messages: unknown[]; tools?: unknown[] }
export interface CaptureChunk { type: 'chunk'; ordinal: number; chunk: { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | { type: 'finish'; reason: { kind: string } } }
export class SdkTrialError extends Error {
  constructor(public readonly trial: string, diagnostic: string, public readonly cancelled = false) { super(`SDK trial failed (${trial}): ${diagnostic}`) }
}
export type CaptureBudget = { type: 'budget'; reason: string }
export type Capture = CaptureBudget | CaptureRequest | CaptureChunk
export async function replaySdkSession(trial: string, id: string) {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(trial, 'home/sessions') })
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
    try {
      const stored = await handle.read()
      return Session.create(SessionId(id), stored.events, handle.header).deriveMessages()
    } finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
}
export async function readAudits(path: string): Promise<AuditRow[]> {
  const rows: AuditRow[] = []
  async function walk(dir: string) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (file.endsWith('.json')) {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'))
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
export function visibleNames(captures: Capture[], sourceKind: string) {
  const schema = z.object({ source: z.object({ kind: z.string(), name: z.string().optional() }) })
  return [...new Set(captures.flatMap(c => c.type === 'request' ? c.messages.flatMap(m => {
    const p = schema.safeParse(m); return p.success && p.data.source.kind === sourceKind && p.data.source.name ? [p.data.source.name] : []
  }) : []))]
}
/** Native model `skill` calls return tool messages, not user skill-invocation messages. */
export function supplementalSkills(events: { type: string; data: unknown }[]) {
  const calls = new Map<string, string>()
  const loaded: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const p = z.object({ message: z.object({ content: z.array(z.unknown()) }) }).safeParse(event.data)
      if (!p.success) continue
      for (const block of p.data.message.content) {
        const call = z.object({ type: z.literal('tool-call'), id: z.string(), name: z.literal('skill'), arguments: z.string() }).safeParse(block)
        if (!call.success) continue
        try { const args = z.object({ name: z.string() }).parse(JSON.parse(call.data.arguments)); calls.set(call.data.id, args.name) } catch { /* Malformed tool calls are not successful loads. */ }
      }
    }
    if (event.type === 'tool/result') {
      const p = z.object({ message: z.object({ toolCallId: z.string(), isError: z.boolean().optional() }) }).safeParse(event.data)
      if (p.success && !p.data.message.isError && calls.has(p.data.message.toolCallId)) loaded.push(calls.get(p.data.message.toolCallId)!)
    }
  }
  return loaded
}
export function submittedSupplementalSkills(captures: Capture[]) {
  return [...new Set(captures.flatMap(c => {
    if (c.type !== 'request') return []
    const events = c.messages.flatMap(message => {
      const p = z.object({ role: z.string() }).safeParse(message)
      if (!p.success || !['assistant', 'tool'].includes(p.data.role)) return []
      return [{ type: p.data.role === 'assistant' ? 'assistant/message' : 'tool/result', data: { message } }]
    })
    return supplementalSkills(events)
  }))]
}
export async function runSdk(options: {
  skills: SkillFixture[]; config: EvalConfig; arm: 'A' | 'B' | 'C'; prompt: string; files?: Record<string, string>
  signal?: AbortSignal; fixtureRequestCap?: number; fixture: boolean; fixtureLoad?: boolean; scores?: Record<string, number>; oracle?: string[]; provider: string; model: string
}) {
  const trialRoot = join(root, '.work/trials')
  await mkdir(trialRoot, { recursive: true })
  const trial = await mkdtemp(join(trialRoot, 'sdk-'))
  const workspace = join(trial, 'workspace'); const home = join(trial, 'home')
  await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true })
  for (const [name, content] of Object.entries(options.files ?? {})) await writeFile(join(workspace, name), content)
  const runtimeSkills = []
  for (const skill of options.skills) {
    const resourcePath = join(workspace, '.eval-skills', skill.name)
    await mkdir(join(resourcePath, 'references'), { recursive: true })
    await writeFile(join(resourcePath, 'SKILL.md'), skill.content)
    await writeFile(join(resourcePath, 'references/checklist.txt'), `Resources for ${skill.name}.\n`)
    runtimeSkills.push({ ...skill, resourcePath })
  }
  const capture = join(trial, 'requests.jsonl')
  const runtimePath = join(trial, 'runtime.json')
  await saveJson(runtimePath, { capture, fixture: options.fixture, fixtureLoad: options.fixtureLoad ?? false, scores: options.scores ?? {}, oracle: options.arm === 'C' ? options.oracle ?? [] : [], skills: runtimeSkills, maxRequests: options.fixture ? options.fixtureRequestCap ?? 20 : 20 })
  const patches: unknown[] = [
    { id: 'skill-filesystem', disabled: true }, { id: 'skill-office', disabled: true },
    { id: 'workspace-dependencies', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'llm-retry', disabled: true }, { id: 'tool-web', disabled: true },
    { id: 'llm-pi-ai', disabled: true }, { id: 'credentials', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { insert: [{ id: 'eval-runtime', name: join(root, 'dist/runtime-plugin.js') }] },
  ]
  if (options.arm === 'B') patches.push({ insert: [{ id: 'eval-sut', name: join(sutRoot, 'dist/index.js'), config: { ...options.config, presetIds: [], onSelectionError: 'continue' } }] })
  const patch = join(trial, 'eval.patch.yml'); await writeFile(patch, stringify(patches))
  const env = scrubEnvironment(!options.fixture)
  env.DSH_HOME = home; env.DSH_AGENTS_HOME = join(home, 'agents'); env.EVAL_RUNTIME_CONFIG = runtimePath
  if (options.fixture) env.TYPESAFE_API_KEY = 'fixture-key'
  const harness = new DeepSeekHarness({ profile: 'sdk', dshHome: home, cwd: workspace, processCwd: workspace, patches: [patch], env, provider: options.provider, model: options.model, maxTokens: 4096, initializeTimeoutMs: 30000, shutdownTimeoutMs: 2000 })
  const started = performance.now()
  let cancelHandler: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      harness.run(options.prompt),
      new Promise<never>((_resolve, reject) => {
        cancelHandler = () => { void harness.close().catch(() => {}); reject(new Error('Evaluation cancelled')) }
        options.signal?.addEventListener('abort', cancelHandler, { once: true })
        if (options.signal?.aborted) cancelHandler()
      }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void harness.close().catch(() => {}); reject(new Error('Evaluation wall deadline exceeded')) }, 120000) }),
    ])
    await harness.close()
    await saveJson(join(trial, 'session-events.json'), result.events)
    const captures = (await readFile(capture, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Capture)
    const audits = await readAudits(join(home, 'storages'))
    return { result, captures, audits, workspace, trial, wallMs: performance.now() - started }
  } catch (error) {
    await harness.close()
    const diagnostic = error instanceof Error ? error.message : 'Runtime failed'
    // Credential values are never persisted, even if a provider repeats one in a diagnostic.
    let safe = diagnostic
    for (const key of [process.env.TYPESAFE_API_KEY, process.env.DEEPSEEK_API_KEY]) if (key) safe = safe.split(key).join('[redacted]')
    await saveJson(join(trial, 'failure.json'), { error: safe })
    const captureText = await readFile(capture, 'utf8').catch(() => '')
    throw new SdkTrialError(trial, safe, /deadline|cancelled/.test(safe) || captureText.includes('"type":"budget"'))
  } finally { if (timer) clearTimeout(timer); if (cancelHandler) options.signal?.removeEventListener('abort', cancelHandler) }
}
