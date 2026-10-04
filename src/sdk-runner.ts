/**
 * SDK 子进程运行器：把受控运行时插件（runtime-plugin.ts）与可选的 SUT 插件装进一个
 * 隔离的 DeepSeekHarness 子进程，产出自包含的 trial 目录
 * （workspace/ 捕获 requests.jsonl / 审计 / 会话事件 / 失败诊断），供判分与事后回放。
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { root, saveJson, scrubEnvironment } from './io.js'
import { sutRoot } from './setup.js'
import { readAudits, readCapturesStrict, type Capture } from './captures.js'
import type { EvalConfig, SkillFixture } from './types.js'

/**
 * SDK 运行的硬预算（主请求上限 / 单请求最大输出 token / 墙钟 deadline）。
 * evaluate.ts 的 controlsHash 用同一组值构造"计划控制"哈希，两处必须保持一致。
 */
export const SDK_LIMITS = { maxRequests: 20, maxTokens: 4096, wallMs: 120000 } as const

/** SDK trial 失败：携带 trial 目录供事后诊断；cancelled 区分 deadline/取消与真故障。 */
export class SdkTrialError extends Error {
  constructor(
    public readonly trial: string,
    diagnostic: string,
    public readonly cancelled = false,
  ) {
    super(`SDK trial failed (${trial}): ${diagnostic}`)
  }
}

/** 用落盘的会话持久化重建一次 trial 的 Session（验证子进程会话可回放）。 */
export async function replaySdkSession(trial: string, id: string) {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(trial, 'home/sessions') })
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
    try {
      const stored = await handle.read()
      return Session.create(SessionId(id), stored.events, handle.header).deriveMessages()
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** 评测中禁用的宿主插件（顺序即 eval.patch.yml 的写入顺序）：把变量收窄到选择行为本身。 */
const DISABLED_PLUGINS: unknown[] = [
  { id: 'skill-filesystem', disabled: true },
  { id: 'skill-office', disabled: true },
  { id: 'workspace-dependencies', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'llm-retry', disabled: true },
  { id: 'tool-web', disabled: true },
  { id: 'llm-pi-ai', disabled: true },
  { id: 'credentials', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
]

/**
 * 运行一次隔离的 SDK trial。
 * - fixture=true：离线模式，runtime-plugin 用打分函数与本地 LLM 适配器替代真实网络；
 * - arm='B' 额外插入 SUT 插件；arm='C' 用 oracle 直接注入技能正文（对照组）；
 * - 任何失败都以 SdkTrialError 抛出，trial 目录里保留 failure.json（凭据已脱敏）。
 */
export async function runSdk(options: {
  skills: SkillFixture[]
  config: EvalConfig
  arm: 'A' | 'B' | 'C'
  prompt: string
  files?: Record<string, string>
  signal?: AbortSignal
  fixtureRequestCap?: number
  fixture: boolean
  fixtureLoad?: boolean
  scores?: Record<string, number>
  oracle?: string[]
  provider: string
  model: string
}) {
  // 1) 建立隔离的 trial 目录：workspace 放任务文件与技能资源，home 作为子进程的 DSH_HOME。
  const trialRoot = join(root, '.work/trials')
  await mkdir(trialRoot, { recursive: true })
  const trial = await mkdtemp(join(trialRoot, 'sdk-'))
  const workspace = join(trial, 'workspace')
  const home = join(trial, 'home')
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })
  for (const [name, content] of Object.entries(options.files ?? {})) await writeFile(join(workspace, name), content)
  const runtimeSkills = []
  for (const skill of options.skills) {
    const resourcePath = join(workspace, '.eval-skills', skill.name)
    await mkdir(join(resourcePath, 'references'), { recursive: true })
    await writeFile(join(resourcePath, 'SKILL.md'), skill.content)
    await writeFile(join(resourcePath, 'references/checklist.txt'), `Resources for ${skill.name}.\n`)
    runtimeSkills.push({ ...skill, resourcePath })
  }
  // 2) runtime-plugin 的启动配置（子进程通过 EVAL_RUNTIME_CONFIG 指向它；键序属于线格式契约）。
  const capture = join(trial, 'requests.jsonl')
  const runtimePath = join(trial, 'runtime.json')
  await saveJson(runtimePath, {
    capture,
    fixture: options.fixture,
    fixtureLoad: options.fixtureLoad ?? false,
    scores: options.scores ?? {},
    oracle: options.arm === 'C' ? (options.oracle ?? []) : [],
    skills: runtimeSkills,
    maxRequests: options.fixture ? (options.fixtureRequestCap ?? SDK_LIMITS.maxRequests) : SDK_LIMITS.maxRequests,
  })
  // 3) 插件补丁：禁用无关宿主插件、插入受控运行时；arm B 再插入 SUT 插件本体。
  const patches: unknown[] = [
    ...DISABLED_PLUGINS,
    { insert: [{ id: 'eval-runtime', name: join(root, 'dist/runtime-plugin.js') }] },
  ]
  if (options.arm === 'B')
    patches.push({
      insert: [
        {
          id: 'eval-sut',
          name: join(sutRoot, 'dist/index.js'),
          config: { ...options.config, presetIds: [], onSelectionError: 'continue' },
        },
      ],
    })
  const patch = join(trial, 'eval.patch.yml')
  await writeFile(patch, stringify(patches))
  // 4) 白名单环境：仅保留运行必需变量，live 模式才透传两把 API key。
  const env = scrubEnvironment(!options.fixture)
  env.DSH_HOME = home
  env.DSH_AGENTS_HOME = join(home, 'agents')
  env.EVAL_RUNTIME_CONFIG = runtimePath
  if (options.fixture) env.TYPESAFE_API_KEY = 'fixture-key'
  const harness = new DeepSeekHarness({
    profile: 'sdk',
    dshHome: home,
    cwd: workspace,
    processCwd: workspace,
    patches: [patch],
    env,
    provider: options.provider,
    model: options.model,
    maxTokens: SDK_LIMITS.maxTokens,
    initializeTimeoutMs: 30000,
    shutdownTimeoutMs: 2000,
  })
  const started = performance.now()
  let cancelHandler: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // 5) 三方竞速：正常运行 vs 调用方取消 vs 墙钟 deadline；后两者都会先关闭子进程再抛错。
    const result = await Promise.race([
      harness.run(options.prompt),
      new Promise<never>((_resolve, reject) => {
        cancelHandler = () => {
          void harness.close().catch(() => {})
          reject(new Error('Evaluation cancelled'))
        }
        options.signal?.addEventListener('abort', cancelHandler, { once: true })
        if (options.signal?.aborted) cancelHandler()
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void harness.close().catch(() => {})
          reject(new Error('Evaluation wall deadline exceeded'))
        }, SDK_LIMITS.wallMs)
      }),
    ])
    await harness.close()
    await saveJson(join(trial, 'session-events.json'), result.events)
    const captures = await readCapturesStrict(capture)
    const audits = await readAudits(join(home, 'storages'))
    return { result, captures, audits, workspace, trial, wallMs: performance.now() - started }
  } catch (error) {
    await harness.close()
    const diagnostic = error instanceof Error ? error.message : 'Runtime failed'
    // 凭据绝不落盘：即使供应商在诊断信息里复述了密钥也要打码。
    let safe = diagnostic
    for (const key of [process.env.TYPESAFE_API_KEY, process.env.DEEPSEEK_API_KEY])
      if (key) safe = safe.split(key).join('[redacted]')
    await saveJson(join(trial, 'failure.json'), { error: safe })
    // 捕获文件缺失（子进程未写出）按空处理，只影响 cancelled 判定。
    const captureText = await readFile(capture, 'utf8').catch(() => '')
    throw new SdkTrialError(trial, safe, /deadline|cancelled/.test(safe) || captureText.includes('"type":"budget"'))
  } finally {
    if (timer) clearTimeout(timer)
    if (cancelHandler) options.signal?.removeEventListener('abort', cancelHandler)
  }
}
