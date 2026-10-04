/**
 * SUT（被测插件 dsh-skill-auto-load-typesafe）生命周期管理：
 * 从本机 git 仓库按固定 ref 导出源码到 .work/sut → 用本仓库锁定的依赖版本编译 →
 * 挂载并校验插件入口 → 把兼容性元数据写入 reports/compatibility.json。
 * loadSut/sutRoot/sutMetadata 供组件测试、SDK 运行器与记录构造复用。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { root, saveJson, hash } from './io.js'

const exec = promisify(execFile)
/** 本机 SUT 仓库与被评测的固定 commit（行为契约：默认值不可变）。 */
export const DEFAULT_PATH = '/Users/yankaizhi/codebase/dsh-skill-auto-load-typesafe'
export const DEFAULT_REF = 'e11e698f3773f1e7c886a464e8156b5c386e48bc'
export const sutRoot = join(root, '.work/sut')
export interface SutPlugin {
  apply(ctx: Context, config: Record<string, unknown>): Promise<void>
  inject: string[]
  name: string
}

export async function setupSut(path = DEFAULT_PATH, ref = DEFAULT_REF) {
  // 解析 ref → 列出受版本控制的源文件（src/**/*.ts + 三个清单文件）→ 全量重建 .work/sut。
  const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--verify', `${ref}^{commit}`])
  const commit = stdout.trim()
  const tracked = (await exec('git', ['-C', path, 'ls-tree', '-r', '--name-only', commit])).stdout.split('\n')
  const files = tracked.filter(
    f => /^src\/.+\.ts$/.test(f) || ['package.json', 'tsconfig.json', 'tsconfig.build.json'].includes(f),
  )
  await rm(sutRoot, { recursive: true, force: true })
  await mkdir(sutRoot, { recursive: true })
  for (const file of files) {
    const content = (await exec('git', ['-C', path, 'show', `${commit}:${file}`])).stdout
    await mkdir(join(sutRoot, file, '..'), { recursive: true })
    await writeFile(join(sutRoot, file), content)
  }
  // 记录依赖对齐说明：SDK 要求 Cordis ~4.0.4，插件声明 4.0.2——功能兼容性以实测为准。
  const manifest = JSON.parse(await readFile(join(sutRoot, 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>
  }
  const metadata = {
    path,
    commit,
    harnessVersion: '0.1.7-rc.1',
    cordisVersion: '4.0.4',
    declaredPeers: manifest.peerDependencies,
    dependencyAdjustment:
      'SDK requires Cordis ~4.0.4; original plugin declares 4.0.2. Functional compatibility is tested with 4.0.4, not a claim of npm peer-range satisfaction.',
    sourceHash: hash(await Promise.all(files.map(f => readFile(join(sutRoot, f), 'utf8')))),
  }
  try {
    await exec(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(sutRoot, 'tsconfig.build.json')],
      { cwd: root },
    )
    const plugin = await loadSut()
    if (typeof plugin.apply !== 'function' || !Array.isArray(plugin.inject))
      throw new Error('Missing plugin entry point')
    await saveJson(join(sutRoot, 'metadata.json'), metadata)
    await saveJson(join(root, 'reports/compatibility.json'), {
      ...metadata,
      compilation: 'passed',
      runtime: 'pending',
      note: 'Runtime mount, injection, persistence and unload are verified by regression and SDK smoke tests.',
    })
    return metadata
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message + ('stdout' in error ? '\n' + String(error.stdout) : '')
        : 'Unknown compilation error'
    await saveJson(join(root, 'reports/compatibility.json'), {
      ...metadata,
      compilation: 'failed',
      runtime: 'not-run',
      error: message,
    })
    throw new Error(`SUT compatibility failed; see reports/compatibility.json\n${message}`)
  }
}

/** 动态加载编译后的 SUT 插件（.work/sut/dist/index.js）。 */
export async function loadSut(): Promise<SutPlugin> {
  return (await import(pathToFileURL(join(sutRoot, 'dist/index.js')).href)) as SutPlugin
}

/** 读取 setupSut 写下的元数据（harnessVersion 以字面量钉死，防止静默升级）。 */
export async function sutMetadata() {
  return z
    .object({ commit: z.string(), harnessVersion: z.literal('0.1.7-rc.1'), sourceHash: z.string() })
    .parse(JSON.parse(await readFile(join(sutRoot, 'metadata.json'), 'utf8')))
}
