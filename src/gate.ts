/**
 * 运行前兼容性门禁：setup/offline/selector/e2e 四个命令的共同前置阶段（不是可分发命令）。
 * 流程：从本机 git 仓库导出固定 ref 的 SUT → 用本仓库锁定的依赖编译 → 挂载检查 →
 * 离线 fixture 模式跑一次真实 SDK 子进程冒烟（选择、注入、审计、会话持久化）。
 * 结果写入 reports/compatibility.json；冒烟失败则阻断一切 live 评测。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { setupSut, DEFAULT_PATH, DEFAULT_REF } from './setup.js'
import { root, saveJson } from './io.js'
import { loadDataset } from './dataset.js'
import { configSchema } from './types.js'
import { runSdk, replaySdkSession } from './sdk-runner.js'
import { visibleNames } from './captures.js'
import type { Flags } from './commands/flags.js'

const exec = promisify(execFile)

/** 读取-合并-写回 compatibility.json（每次都重新读盘：setupSut 刚写入过新版本）。 */
async function updateCompatibility(patch: Record<string, unknown>) {
  const compatibility = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await readFile(join(root, 'reports/compatibility.json'), 'utf8')))
  await saveJson(join(root, 'reports/compatibility.json'), { ...compatibility, ...patch })
}

export async function runGate(flags: Flags) {
  await setupSut(flags['sut-path'] ?? DEFAULT_PATH, flags['sut-ref'] ?? DEFAULT_REF)
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')])
  // 数据集在 try 之外装载：装载失败不属于运行时不兼容，不写 compatibility.json。
  const d = await loadDataset()
  const config = configSchema.parse({})
  try {
    const smoke = await runSdk({
      skills: d.skills,
      config,
      arm: 'B',
      prompt: '修复代码',
      fixture: true,
      scores: { 'code-fix': 0.95 },
      provider: 'eval-fixture',
      model: 'fixture',
    })
    if (
      smoke.result.finalResponse !== 'offline-sdk-ok' ||
      !visibleNames(smoke.captures, 'skill-auto-load-typesafe').includes('code-fix') ||
      !smoke.audits.some(a => a.loaded?.includes('code-fix'))
    )
      throw new Error('SDK compatibility smoke failed')
    if (!JSON.stringify(await replaySdkSession(smoke.trial, smoke.result.sessionId)).includes(d.skills[0]!.content))
      throw new Error('SDK Session persistence failed')
    await updateCompatibility({ runtime: 'passed', smokeTrial: smoke.trial })
  } catch (error) {
    await updateCompatibility({
      runtime: 'failed',
      error: error instanceof Error ? error.message : 'Runtime gate failed',
    })
    throw new Error('Runtime compatibility failed; live evaluation blocked. See reports/compatibility.json')
  }
}
