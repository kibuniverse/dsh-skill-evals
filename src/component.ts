import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { SkillFixture, AuditRow } from './types.js'
import { loadSut, sutRoot } from './setup.js'
import { pathToFileURL } from 'node:url'

class TestCredentials extends CredentialProvider {
  key: string | undefined
  constructor(ctx: Context, config: { key: string | undefined }) { super(ctx); this.key = config.key }
  async resolve() { return this.key ? { value: this.key, source: 'test' } : undefined }
  async describe() { return { configured: !!this.key, writable: true } }
  async set(_ref: string, value: string) { this.key = value }
  async unset() { this.key = undefined }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: true } }
  async listRecords() { return [] }
  async modifyRecord() { return undefined }
  async deleteRecord() {}
}
function unsupported(): never { throw new Error('Component fixture does not drive the Agent loop; use SDK smoke/e2e') }
export function fakeAgent(ctx: Context, cwd: string, preset = 'standard'): Agent {
  const id = SessionId(randomUUID())
  return {
    id, ctx, options: {}, status: 'idle',
    session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false, agentPreset: preset }),
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported },
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported, cancel: unsupported,
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
}
export const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
export function responseFor(body: Record<string, unknown>, score: (name: string) => number) {
  const questions = body.questions as Record<string, { instructions: { skill: { name: string } } }>
  return { model: 'fixture-model', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'noul', noul: score(q.instructions.skill.name) }])), usage: { input_tokens: 100, output_tokens: Object.keys(questions).length } }
}
export async function createComponent(skills: SkillFixture[], config: Record<string, unknown> = {}, key: string | undefined = 'fixture-key') {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-eval-component-'))
  const ctx = new Context()
  await ctx.plugin(AgentRegistry); await ctx.plugin(SkillRegistry)
  await ctx.plugin(TestCredentials, { key })
  await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(workspace, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  for (const skill of skills) ctx.skills.register({ ...skill, source: 'runtime', resourceBase: { kind: 'directory', path: join(workspace, 'skills', skill.name) } })
  const plugin = await loadSut(); const fiber = ctx.plugin(plugin, { presetIds: [], ...config }); await fiber
  const agent = fakeAgent(ctx, workspace)
  const auditModule = await import(pathToFileURL(join(sutRoot, 'dist/audit.js')).href)
  async function audits(): Promise<AuditRow[]> {
    // Read the same domain after the plugin has released ownership.
    await fiber.dispose()
    const domain = await ctx.storageDomain.open(auditModule.auditSpec)
    const entries = domain.table('requests').entries()
    const values = Array.from(entries, ([, value]) => value) as AuditRow[]
    await domain.close(); return values
  }
  return { ctx, agent, fiber, workspace, audits,
    async dispatch(text: string, signal = new AbortController().signal, decision?: PreStepDecision) {
      const messages = [user(text)]
      return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal }, async (): Promise<PreStepDecision> => decision ?? { kind: 'enter', messages, startsRequestSeries: true })
    },
    async close() { await ctx.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) },
  }
}
