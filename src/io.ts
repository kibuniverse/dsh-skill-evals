/**
 * 共享 IO 层：仓库根路径解析、稳定哈希、JSON/JSONL 持久化、子进程环境白名单。
 *
 * 安全说明：saveRecords/readRecords 每一行都过 recordSchema 校验（未知键被剥除），
 * scrubEnvironment 是唯一的子进程环境出口——默认只透传运行必需变量，live 模式才附上 API key。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordSchema, type RunRecord } from './types.js'

/** 仓库根目录（本文件位于 src/ 下一级；不可移动本文件）。 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 稳定哈希：JSON 序列化后取 sha256（输入对象的键序会影响结果，见 types.ts 的键序警示）。 */
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 写 JSON 文件（2 空格缩进 + 末尾换行），自动创建父目录。 */
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

/** 读取 records.jsonl：逐行 parse 并过 recordSchema 校验。 */
export async function readRecords(path: string): Promise<RunRecord[]> {
  const source = await readFile(path, 'utf8')
  return source
    .split('\n')
    .filter(line => line.trim())
    .map(line => recordSchema.parse(JSON.parse(line)))
}

/** 写 records.jsonl：逐行 parse（校验 + 按 schema 键序重建）后拼接落盘。 */
export async function saveRecords(path: string, rows: RunRecord[]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rows.map(row => JSON.stringify(recordSchema.parse(row))).join('\n') + '\n')
}

/**
 * 构造子进程环境白名单：只保留 PATH/临时目录/locale 等运行必需变量；
 * live=true 时才透传两把 API key 与 DEEPSEEK_BASE_URL。
 * 显式置空的三个 DSH_* 变量用于屏蔽宿主的全局运行时配置。
 */
export function scrubEnvironment(live: boolean): NodeJS.ProcessEnv {
  const names = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) if (process.env[name]) env[name] = process.env[name]
  if (live)
    for (const name of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])
      if (process.env[name]) env[name] = process.env[name]
  env.DSH_PRIMARY_RUNTIME = ''
  env.DSH_BUNDLED_PRIMARY_RUNTIME = ''
  env.DSH_BUNDLED_SKILL_DIR = ''
  return env
}
