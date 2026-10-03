import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordSchema, type RunRecord } from './types.js'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}
export async function readRecords(path: string): Promise<RunRecord[]> {
  const source = await readFile(path, 'utf8')
  return source.split('\n').filter(line => line.trim()).map(line => recordSchema.parse(JSON.parse(line)))
}
export async function saveRecords(path: string, rows: RunRecord[]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rows.map(row => JSON.stringify(recordSchema.parse(row))).join('\n') + '\n')
}
export function scrubEnvironment(live: boolean): NodeJS.ProcessEnv {
  const names = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) if (process.env[name]) env[name] = process.env[name]
  if (live) for (const name of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) if (process.env[name]) env[name] = process.env[name]
  env.DSH_PRIMARY_RUNTIME = ''; env.DSH_BUNDLED_PRIMARY_RUNTIME = ''; env.DSH_BUNDLED_SKILL_DIR = ''
  return env
}
