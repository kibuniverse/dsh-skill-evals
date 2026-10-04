import { afterEach, expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { Session } from '@deepseek-ai/dsh-session'
import { createComponent, user } from '../src/component.js'
import { responseFor } from '../src/fixtures.js'
import { loadDataset } from '../src/dataset.js'

const data = await loadDataset()
const skills = data.skills.slice(0, 3)
const opened: Awaited<ReturnType<typeof createComponent>>[] = []
async function harness(config: Record<string, unknown> = {}, key: string | undefined = 'fixture-secret') {
  const h = await createComponent(skills, config, key)
  opened.push(h)
  return h
}
function reply(scores: Record<string, number>) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    Response.json(responseFor(JSON.parse(String(init?.body)), n => scores[n] ?? 0.05)),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('injects complete resource-aware instructions, preserves decision and replays standard Session messages', async () => {
  reply({ 'code-fix': 0.95 })
  const h = await harness()
  const r = await h.dispatch('修复代码')
  expect(r.kind).toBe('enter')
  if (r.kind !== 'enter') throw new Error('Missing entry')
  expect(r.startsRequestSeries).toBe(true)
  expect(r.messages).toHaveLength(2)
  expect(JSON.stringify(r.messages[1])).toContain(skills[0]!.content)
  expect(JSON.stringify(r.messages[1])).toContain(h.workspace)
  for (const m of r.messages) h.agent.session.append('user/message', m, { surfaceOp: 'append' })
  const restored = Session.create(h.agent.session.id, h.agent.session.snapshotEvents(), h.agent.session.header)
  expect(restored.deriveMessages()).toEqual(h.agent.session.deriveMessages())
  const audits = await h.audits()
  expect(audits[0]?.loaded).toEqual(['code-fix'])
  expect(JSON.stringify(audits)).not.toContain('fixture-secret')
})
it('excludes already-visible skills before requesting scores and makes no second request when nothing remains', async () => {
  const h = await harness()
  const fetch = reply({ 'code-fix': 0.95 })
  const first = await h.dispatch('Fix code')
  if (first.kind !== 'enter') throw new Error('Missing entry')
  for (const m of first.messages) h.agent.session.append('user/message', m, { surfaceOp: 'append' })
  const second = await h.dispatch('Fix again')
  expect(second.kind === 'enter' && second.messages.length).toBe(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  const secondRequest = JSON.parse(String(fetch.mock.calls[1]![1]!.body))
  expect(JSON.stringify(secondRequest)).not.toContain(skills[0]!.description)
})
it('makes zero requests when its sole skill is already visible', async () => {
  const h = await createComponent([skills[0]!])
  opened.push(h)
  const fetch = reply({ 'code-fix': 0.95 })
  const first = await h.dispatch('fix')
  if (first.kind !== 'enter') throw new Error('Missing entry')
  for (const m of first.messages) h.agent.session.append('user/message', m, { surfaceOp: 'append' })
  fetch.mockClear()
  const second = await h.dispatch('fix again')
  expect(second.kind === 'enter' && second.messages.length).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(await h.audits()).toHaveLength(1)
})
it('reloads changed content and reloads after visible history is compacted away', async () => {
  const h = await harness()
  reply({ 'code-fix': 0.95 })
  const first = await h.dispatch('fix')
  if (first.kind !== 'enter') throw new Error('Missing entry')
  for (const m of first.messages) h.agent.session.append('user/message', m, { surfaceOp: 'append' })
  const original = (await h.ctx.skills.get('code-fix'))!
  const get = vi.spyOn(h.ctx.skills, 'get').mockResolvedValue({ ...original, content: 'Changed complete instructions' })
  const changed = await h.dispatch('fix again')
  expect(JSON.stringify(changed)).toContain('Changed complete instructions')
  get.mockRestore()
  vi.spyOn(h.agent.session, 'deriveMessages').mockReturnValue([])
  const compacted = await h.dispatch('fix again')
  expect(compacted.kind === 'enter' && compacted.messages.length).toBe(2)
})
it('fills the count cap after skipping an oversized higher-ranked skill', async () => {
  const h = await harness({ maxSkills: 1, maxInjectedBytes: 1500 })
  reply({ 'code-fix': 0.99, 'code-review': 0.9 })
  const original = h.ctx.skills.get.bind(h.ctx.skills)
  vi.spyOn(h.ctx.skills, 'get').mockImplementation(async (name, options) => {
    const skill = await original(name, options)
    return skill && name === 'code-fix' ? { ...skill, content: '中'.repeat(5000) } : skill
  })
  await h.dispatch('Review code')
  const audit = (await h.audits())[0]!
  expect(audit.loaded).toEqual(['code-review'])
  expect(audit.skipped).toContainEqual({ name: 'code-fix', reason: 'content-budget' })
})
it('includes the threshold boundary and uses skill names to break equal-score ties', async () => {
  const h = await harness({ threshold: 0.75, maxSkills: 1 })
  reply({ 'code-fix': 0.75, 'code-review': 0.75, 'unit-test': 0.749 })
  await h.dispatch('code')
  const a = (await h.audits())[0]!
  expect(a.selected).toEqual(['code-fix', 'code-review'])
  expect(a.loaded).toEqual(['code-fix'])
})
it.each(['reject', 'empty', 'continuation', 'preset'])('does not select on an ineligible %s step', async kind => {
  const h = await harness(kind === 'preset' ? { presetIds: ['minimal'] } : {})
  const fetch = reply({ 'code-fix': 0.95 })
  await h.dispatch(
    kind === 'empty' ? '  ' : 'fix',
    undefined,
    kind === 'reject' ? { kind: 'reject' } : kind === 'continuation' ? { kind: 'enter', messages: [] } : undefined,
  )
  expect(fetch).not.toHaveBeenCalled()
})
it('leaves explicit slash invocations to native skill loading and excludes model-forbidden skills', async () => {
  const h = await harness()
  const fetch = reply({ 'code-review': 0.95 })
  h.ctx.skills.register({
    name: 'private',
    description: 'private',
    source: 'runtime',
    content: 'Secret instructions',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  await h.dispatch('/code-fix please')
  const request = JSON.parse(String(fetch.mock.calls[0]![1]!.body))
  expect(JSON.stringify(request)).not.toContain(skills[0]!.description)
  expect(JSON.stringify(request)).not.toContain('private')
})
it('uses Agent scope and rechecks invocation permissions during loading', async () => {
  const h = await harness()
  const scope = createScope(h.ctx, h.agent)
  await scope.ctx.inject(['skills'], ctx => {
    ctx.skills.register({ ...skills[0]!, content: 'Scoped instructions', source: 'runtime' })
  })
  reply({ 'code-fix': 0.9 })
  const result = await h.dispatch('fix')
  expect(JSON.stringify(result)).toContain('Scoped instructions')
  const original = (await h.ctx.skills.get('code-fix'))!
  vi.spyOn(h.ctx.skills, 'get').mockResolvedValue({
    ...original,
    invocation: { modelInvocable: false, userInvocable: true },
  })
  const forbidden = await h.dispatch('fix')
  expect(forbidden.kind === 'enter' && forbidden.messages.length).toBe(1)
  await scope.dispose()
})
it('skips incomplete discovery and errors on an oversized serialized request', async () => {
  const h = await harness()
  const fetch = reply({ 'code-fix': 0.9 })
  const snapshot = vi.spyOn(h.ctx.skills, 'snapshot').mockResolvedValue({ skills: [], complete: false })
  await h.dispatch('fix')
  expect(fetch).not.toHaveBeenCalled()
  snapshot.mockRestore()
  const small = await harness({ maxInputBytes: 20 })
  await expect(small.dispatch('中文'.repeat(50))).rejects.toThrow('maxInputBytes')
  expect(fetch).not.toHaveBeenCalled()
})
it.each([401, 403, 400, 422])('does not downgrade HTTP %s errors or persist provider secrets', async status => {
  const h = await harness()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'fixture-secret private details' }, { status })),
  )
  await expect(h.dispatch('fix')).rejects.toThrow('configuration-or-authentication')
  expect(JSON.stringify(await h.audits())).not.toContain('fixture-secret')
})
it('continues for transient errors, fails in strict mode, and rejects malformed response IDs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 503 })),
  )
  const h = await harness()
  expect((await h.dispatch('fix')).kind).toBe('enter')
  const strict = await harness({ onSelectionError: 'fail' })
  await expect(strict.dispatch('fix')).rejects.toThrow('selection-failed')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        model: 'fixture',
        answers: { wrong: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ),
  )
  await expect(strict.dispatch('fix')).rejects.toThrow('selection-failed')
})
it('requires a credential before dispatch', async () => {
  const h = await harness({}, '')
  const fetch = reply({ 'code-fix': 0.9 })
  await expect(h.dispatch('fix')).rejects.toThrow('TYPESAFE_API_KEY')
  expect(fetch).not.toHaveBeenCalled()
})
it('propagates user cancellation and unload cancellation instead of continuing', async () => {
  const h = await harness()
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      controller.abort(new Error('User stopped'))
      throw controller.signal.reason
    }),
  )
  await expect(h.dispatch('fix', controller.signal)).rejects.toThrow('User stopped')
  let ready!: () => void
  const started = new Promise<void>(r => {
    ready = r
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
          ready()
        }),
    ),
  )
  const operation = h.dispatch('fix').then(
    () => false,
    () => true,
  )
  await started
  await h.fiber.dispose()
  expect(await operation).toBe(true)
})
it.each(['continue', 'fail'])('honors total deadline with %s policy', async onSelectionError => {
  const h = await harness({ timeoutMs: 40, onSelectionError })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        }),
    ),
  )
  if (onSelectionError === 'fail') await expect(h.dispatch('fix')).rejects.toThrow('deadline')
  else expect((await h.dispatch('fix')).kind).toBe('enter')
})
it('fails on audit write errors rather than treating storage errors as transient selection failures', async () => {
  const h = await harness()
  const original = h.ctx.storageDomain.open.bind(h.ctx.storageDomain)
  // A failing backing write is injected through the domain opened by a fresh plugin instance.
  await h.fiber.dispose()
  vi.spyOn(h.ctx.storageDomain, 'open').mockImplementation(async spec => {
    const domain = await original(spec)
    const table = domain.table('requests')
    vi.spyOn(table, 'put').mockRejectedValue(new Error('Audit unavailable'))
    return domain
  })
  const { loadSut } = await import('../src/setup.js')
  await h.ctx.plugin(await loadSut(), { presetIds: [] })
  const fetch = reply({ 'code-fix': 0.9 })
  await expect(h.dispatch('fix')).rejects.toThrow('Audit unavailable')
  expect(fetch).not.toHaveBeenCalled()
})

it('propagates skill discovery and body read errors and removes its hook on unload', async () => {
  const h = await harness()
  const fetch = reply({ 'code-fix': 0.95 })
  const snapshot = vi.spyOn(h.ctx.skills, 'snapshot').mockRejectedValue(new Error('Discovery unavailable'))
  await expect(h.dispatch('fix')).rejects.toThrow('Discovery unavailable')
  expect(fetch).not.toHaveBeenCalled()
  snapshot.mockRestore()
  const get = vi.spyOn(h.ctx.skills, 'get').mockRejectedValue(new Error('Body unavailable'))
  await expect(h.dispatch('fix')).rejects.toThrow('Body unavailable')
  get.mockRestore()
  await h.fiber.dispose()
  fetch.mockClear()
  const result = await h.dispatch('fix again')
  expect(result.kind === 'enter' && result.messages.length).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('accounts for UTF-8 body bytes rather than character count', async () => {
  const h = await harness({ maxInjectedBytes: 1500 })
  reply({ 'code-fix': 0.95 })
  const skill = (await h.ctx.skills.get('code-fix'))!
  const content = '中'.repeat(600)
  expect(content.length).toBeLessThan(1500)
  expect(Buffer.byteLength(content)).toBeGreaterThan(1500)
  vi.spyOn(h.ctx.skills, 'get').mockResolvedValue({ ...skill, content })
  const result = await h.dispatch('fix')
  expect(result.kind === 'enter' && result.messages.length).toBe(1)
  expect((await h.audits())[0]?.skipped).toContainEqual({ name: 'code-fix', reason: 'content-budget' })
})
