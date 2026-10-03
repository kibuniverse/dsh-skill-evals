/** Evaluation-only runtime extension: frozen skills, request capture, budgets and an offline adapter. */
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { z } from 'zod'
import { CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Only the scrubbed launch environment is a credential source. */
class EnvironmentCredentials extends CredentialProvider {
  async resolve(ref: CredentialRef) { const value = process.env[ref]; return value ? { value, source: 'env' } : undefined }
  async describe(ref: CredentialRef) { return { configured: !!process.env[ref], writable: false } }
  async set() { throw new Error('Evaluation credentials are read-only') }
  async unset() { throw new Error('Evaluation credentials are read-only') }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: false } }
  async listRecords() { return [] }
  async modifyRecord() { return undefined }
  async deleteRecord() { throw new Error('Evaluation credentials are read-only') }
}
import { responseFor } from './component.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'eval-oracle': { kind: 'eval-oracle'; form: 'instructions'; name: string } }
}
export const name = 'evaluation-runtime'
export const inject = ['llm', 'skills', 'agents']
const optionsSchema = z.object({
  capture: z.string(), fixture: z.boolean(), fixtureLoad: z.boolean().default(false), oracle: z.array(z.string()),
  skills: z.array(z.object({ name: z.string(), description: z.string(), whenToUse: z.string(), content: z.string(), resourcePath: z.string() })),
  scores: z.record(z.string(), z.number()), maxRequests: z.number().int().positive(),
})
export async function apply(ctx: Context): Promise<void> {
  const path = process.env.EVAL_RUNTIME_CONFIG
  if (!path) throw new Error('Missing evaluation runtime config')
  await ctx.plugin(EnvironmentCredentials)
  const config = optionsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  await mkdir(dirname(config.capture), { recursive: true })
  const write = async (record: unknown) => appendFile(config.capture, JSON.stringify(record) + '\n')
  for (const skill of config.skills) ctx.effect(() => ctx.skills.register({ name: skill.name, description: skill.description, whenToUse: skill.whenToUse, content: skill.content, source: 'runtime', resourceBase: { kind: 'directory', path: skill.resourcePath } }))
  if (config.fixture) {
    const saved = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body))
      const parsed = z.record(z.string(), z.unknown()).parse(body)
      if (!parsed.questions) throw new Error('Offline evaluation refuses unexpected network calls')
      return Response.json(responseFor(parsed, name => config.scores[name] ?? 0.05))
    }
    ctx.effect(() => () => { globalThis.fetch = saved })
    class FixtureAdapter extends LlmAdapter {
      step = 0
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        options.signal?.throwIfAborted()
        const step = this.step++
        if (config.fixtureLoad && step < 3) {
          const block = { type: 'tool-call' as const, id: ToolCallId(`fixture-${step}`), name: step === 0 ? 'skill' : step === 1 ? 'read' : 'write', arguments: JSON.stringify(step === 0 ? { name: 'code-fix' } : step === 1 ? { file_path: config.skills.find(s => s.name === 'code-fix')!.resourcePath + '/references/checklist.txt' } : { file_path: config.skills.find(s => s.name === 'code-fix')!.resourcePath + '/smoke.json', content: '{"verified":true}' }) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 3 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'offline-sdk-ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline-sdk-ok' } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['eval-fixture'], new FixtureAdapter()))
  }
  if (config.oracle.length) ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!decision.messages.some(m => m.source.kind === 'user')) return decision
    const additions = []
    for (const skillName of config.oracle) {
      const skill = await ctx.skills.get(skillName, { cwd: agent.session.header.cwd, scope: agent })
      if (!skill) throw new Error(`Oracle skill missing: ${skillName}`)
      additions.push(createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill) }], source: { kind: 'eval-oracle', form: 'instructions', name: skillName } }))
    }
    return { ...decision, messages: [...decision.messages, ...additions] }
  }, { prepend: true })
  let calls = 0
  ctx.on('llm/stream', async function* (options, next) {
    if (options.maxTokens === undefined || options.maxTokens > 4096) {
      await write({ type: 'budget', reason: 'output-token-limit' })
      throw new Error('Evaluation output-token budget exceeded')
    }
    if (!options.purpose && ++calls > config.maxRequests) {
      await write({ type: 'budget', reason: 'main-request-limit' })
      throw new Error('Evaluation request budget exceeded')
    }
    await write({ type: 'request', ordinal: calls, timestamp: Date.now(), provider: options.provider, model: options.model, maxTokens: options.maxTokens, purpose: options.purpose ?? null, messages: options.messages, tools: options.tools })
    for await (const chunk of next()) {
      if (chunk.type === 'usage' || chunk.type === 'finish') await write({ type: 'chunk', ordinal: calls, chunk })
      yield chunk
    }
  }, { prepend: true })
}
