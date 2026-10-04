/**
 * 评测专用运行时插件（装进 SDK 子进程，经 eval.patch.yml 插入，产物为 dist/runtime-plugin.js）：
 * 冻结技能目录、捕获每次模型请求与用量、强制请求/输出预算，并在 fixture 模式下
 * 用本地适配器与打分函数替代真实网络。此文件位置/名称不可改（sdk-runner 按路径引用）。
 * 注册顺序（凭据 → 技能 → fixture → oracle → 捕获/预算）是行为契约，拆分时保持不变。
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { z } from 'zod'
import { CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { responseFor } from './fixtures.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'eval-oracle': { kind: 'eval-oracle'; form: 'instructions'; name: string }
  }
}

export const name = 'evaluation-runtime'
export const inject = ['llm', 'skills', 'agents']

/** 与 sdk-runner 写出的 runtime.json 对应的启动配置 schema（线格式契约）。 */
const optionsSchema = z.object({
  capture: z.string(),
  fixture: z.boolean(),
  fixtureLoad: z.boolean().default(false),
  oracle: z.array(z.string()),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      whenToUse: z.string(),
      content: z.string(),
      resourcePath: z.string(),
    }),
  ),
  scores: z.record(z.string(), z.number()),
  maxRequests: z.number().int().positive(),
})
type Options = z.output<typeof optionsSchema>

/** 凭据只来自脱敏后的启动环境：只读，禁止写入/列举。 */
class EnvironmentCredentials extends CredentialProvider {
  async resolve(ref: CredentialRef) {
    const value = process.env[ref]
    return value ? { value, source: 'env' } : undefined
  }
  async describe(ref: CredentialRef) {
    return { configured: !!process.env[ref], writable: false }
  }
  async set() {
    throw new Error('Evaluation credentials are read-only')
  }
  async unset() {
    throw new Error('Evaluation credentials are read-only')
  }
  async readRecord() {
    return undefined
  }
  async describeRecord() {
    return { configured: false, writable: false }
  }
  async listRecords() {
    return []
  }
  async modifyRecord() {
    return undefined
  }
  async deleteRecord() {
    throw new Error('Evaluation credentials are read-only')
  }
}

/** 注册冻结的技能目录：所有技能来自 runtime.json，均以 runtime 目录为资源基。 */
function registerRuntimeSkills(ctx: Context, config: Options) {
  for (const skill of config.skills)
    ctx.effect(() =>
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: skill.resourcePath },
      }),
    )
}

/** fixture 模式：拦截 TypeSafe 打分请求 + 本地 LLM 适配器（fixtureLoad=true 时先演练工具调用链）。 */
function installFixtureModel(ctx: Context, config: Options) {
  const saved = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body: unknown = JSON.parse(String(init?.body))
    const parsed = z.record(z.string(), z.unknown()).parse(body)
    if (!parsed.questions) throw new Error('Offline evaluation refuses unexpected network calls')
    return Response.json(responseFor(parsed, name => config.scores[name] ?? 0.05))
  }
  ctx.effect(() => () => {
    globalThis.fetch = saved
  })
  class FixtureAdapter extends LlmAdapter {
    step = 0
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      options.signal?.throwIfAborted()
      const step = this.step++
      // 前三步演练真实 Agent 形态：skill 工具调用 → 读资源 → 写文件，随后给出固定答复。
      if (config.fixtureLoad && step < 3) {
        const codeFix = config.skills.find(s => s.name === 'code-fix')!
        const block = {
          type: 'tool-call' as const,
          id: ToolCallId(`fixture-${step}`),
          name: step === 0 ? 'skill' : step === 1 ? 'read' : 'write',
          arguments: JSON.stringify(
            step === 0
              ? { name: 'code-fix' }
              : step === 1
                ? { file_path: codeFix.resourcePath + '/references/checklist.txt' }
                : { file_path: codeFix.resourcePath + '/smoke.json', content: '{"verified":true}' },
          ),
        }
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

/** oracle 臂（C）：在每个用户回合后追加指定技能的完整正文（eval-oracle 来源标记）。 */
function installOracleHook(ctx: Context, config: Options) {
  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!decision.messages.some(m => m.source.kind === 'user')) return decision
      const additions = []
      for (const skillName of config.oracle) {
        const skill = await ctx.skills.get(skillName, { cwd: agent.session.header.cwd, scope: agent })
        if (!skill) throw new Error(`Oracle skill missing: ${skillName}`)
        additions.push(
          createUserMessage({
            content: [{ type: 'text', text: renderSkillContent(skill) }],
            source: { kind: 'eval-oracle', form: 'instructions', name: skillName },
          }),
        )
      }
      return { ...decision, messages: [...decision.messages, ...additions] }
    },
    { prepend: true },
  )
}

/** 捕获与预算：每次 llm/stream 先写 request 捕获；无 purpose 的主请求计数触顶即抛错，
 *  output 超限同样先写 budget 标记再抛错（两类标记都会被 runSdk 归类为 cancelled）。 */
function installCaptureAndBudgets(ctx: Context, config: Options, write: (record: unknown) => Promise<void>) {
  let calls = 0
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (options.maxTokens === undefined || options.maxTokens > 4096) {
        await write({ type: 'budget', reason: 'output-token-limit' })
        throw new Error('Evaluation output-token budget exceeded')
      }
      if (!options.purpose && ++calls > config.maxRequests) {
        await write({ type: 'budget', reason: 'main-request-limit' })
        throw new Error('Evaluation request budget exceeded')
      }
      await write({
        type: 'request',
        ordinal: calls,
        timestamp: Date.now(),
        provider: options.provider,
        model: options.model,
        maxTokens: options.maxTokens,
        purpose: options.purpose ?? null,
        messages: options.messages,
        tools: options.tools,
      })
      for await (const chunk of next()) {
        if (chunk.type === 'usage' || chunk.type === 'finish') await write({ type: 'chunk', ordinal: calls, chunk })
        yield chunk
      }
    },
    { prepend: true },
  )
}

export async function apply(ctx: Context): Promise<void> {
  const path = process.env.EVAL_RUNTIME_CONFIG
  if (!path) throw new Error('Missing evaluation runtime config')
  await ctx.plugin(EnvironmentCredentials)
  const config = optionsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  await mkdir(dirname(config.capture), { recursive: true })
  const write = async (record: unknown) => appendFile(config.capture, JSON.stringify(record) + '\n')
  registerRuntimeSkills(ctx, config)
  if (config.fixture) installFixtureModel(ctx, config)
  if (config.oracle.length) installOracleHook(ctx, config)
  installCaptureAndBudgets(ctx, config, write)
}
