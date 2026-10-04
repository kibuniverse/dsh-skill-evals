import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { root, scrubEnvironment } from '../src/io.js'
import { join } from 'node:path'
const exec = promisify(execFile)
it.each([
  ['selector', [], 'TYPESAFE_API_KEY'],
  ['e2e', [], 'explicit --provider and --model'],
  ['e2e', ['--provider', 'deepseek-official', '--model', 'example'], 'TYPESAFE_API_KEY'],
])('refuses a %s run with missing configuration before any API call', async (command, flags, message) => {
  try {
    await exec(
      process.execPath,
      [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), command, ...flags],
      { cwd: root, env: scrubEnvironment(false) },
    )
    throw new Error('Unexpected successful live run')
  } catch (error) {
    expect(error).toHaveProperty('code', 1)
    expect(error).toHaveProperty('stderr', expect.stringContaining(message))
    expect(error).toHaveProperty('stderr', expect.stringContaining('no calls made'))
  }
})
