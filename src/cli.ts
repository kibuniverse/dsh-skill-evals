/**
 * CLI 入口：解析 argv → 前置校验（顺序即行为契约）→ 门禁（gate.ts）→ 分发到命令模块。
 *
 * 两个刻意保留的位置：
 * - parseArgs 在模块顶层执行：未知 flag 走"未捕获异常 + 退出 1"的既有行为（挪进 try 会改变 stderr 形态）；
 * - 顶层 try/catch 只包住 main()：命令内抛错统一打印 error.message 并置退出码 1。
 */
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { root } from './io.js'
import { loadDataset, readPrices } from './dataset.js'
import { configSchema, type RunRecord } from './types.js'
import { runGate } from './gate.js'
import { OPTIONS, integer, type Flags, type RunContext } from './commands/flags.js'
import { runReportCommand } from './commands/report.js'
import { runOffline, runOfflineReplay } from './commands/offline.js'
import { runSelector } from './commands/selector.js'
import { runE2e } from './commands/e2e.js'

const parsed = parseArgs({ args: process.argv.slice(3), options: OPTIONS })
const command = process.argv[2]
const flags = parsed.values as Flags

const HELP =
  'Commands: setup | offline | selector | e2e | report\n--sut-path PATH --sut-ref SHA --input records.jsonl --output DIR\n--split dev|holdout --limit N --repeats N --threshold P --max-skills N\n--typesafe-model VERSION --provider ROUTE --model MODEL --prices prices.json\nLive commands require environment credentials. Offline scores are synthetic demo data.'

async function main() {
  if (flags.help) {
    console.log(HELP)
    return
  }
  const output = resolve(flags.output ?? join(root, 'reports', command ?? 'offline'))
  // report 命令只做重放渲染，不过门禁、不接触 SUT。
  if (command === 'report') return void (await runReportCommand(flags, output))
  // 凭据/参数校验必须先于 gate：缺配置时不得触碰 SUT 仓库或网络（"no calls made"）。
  if (command === 'selector' && !process.env.TYPESAFE_API_KEY?.trim())
    throw new Error('eval:selector requires TYPESAFE_API_KEY; no calls made')
  if (command === 'e2e') {
    if (!flags.provider || !flags.model)
      throw new Error('eval:e2e requires explicit --provider and --model; no calls made')
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('eval:e2e requires TYPESAFE_API_KEY; no calls made')
    if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('eval:e2e requires DEEPSEEK_API_KEY; no calls made')
  }
  if (!['setup', 'offline', 'selector', 'e2e'].includes(command ?? '')) throw new Error('Unknown command; use --help')
  await runGate(flags)
  if (command === 'setup') {
    console.log('SUT compilation and real SDK-loop compatibility passed (no paid calls).')
    return
  }
  // offline --input：过完 gate 后从既有记录重放（历史行为如此，重放也要求门禁通过）。
  if (command === 'offline' && flags.input) return void (await runOfflineReplay(flags, output))
  // 装载各命令共享的上下文；live 命令挂载 SIGINT/SIGTERM → AbortController。
  const config = configSchema.parse({
    threshold: flags.threshold === undefined ? 0.75 : Number(flags.threshold),
    maxSkills: flags['max-skills'] === undefined ? 3 : Number(flags['max-skills']),
    model: flags['typesafe-model'] ?? 'jev-latest',
  })
  const cancellation = new AbortController()
  if (command === 'selector' || command === 'e2e') {
    process.once('SIGINT', () => cancellation.abort(new Error('Caller cancelled')))
    process.once('SIGTERM', () => cancellation.abort(new Error('Caller cancelled')))
  }
  const ctx: RunContext = {
    output,
    config,
    repeats: integer(flags.repeats, 3),
    d: await loadDataset(),
    prices: await readPrices(flags.prices),
    signal: cancellation.signal,
  }
  const rows: RunRecord[] =
    command === 'e2e'
      ? await runE2e(flags, ctx)
      : command === 'selector'
        ? await runSelector(flags, ctx)
        : await runOffline(flags, ctx)
  // 存在基础设施失败或被取消的行时，报告仍产出，但以退出码 2 提示调用方。
  if (rows.some(r => r.status === 'infrastructure-failed' || r.status === 'cancelled')) process.exitCode = 2
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Evaluation failed')
  process.exitCode = 1
}
