import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadDataset } from '../src/dataset.js'
import { configSchema } from '../src/types.js'
import { runSdk } from '../src/sdk-runner.js'
import { visibleNames, supplementalSkills, submittedSupplementalSkills } from '../src/captures.js'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { root, hash } from '../src/io.js'

it('drives real SDK Agent loops in A/B/C with equal task controls and frozen catalogs', async () => {
  const d = await loadDataset()
  const controls: string[] = []
  for (const arm of ['A', 'B', 'C'] as const) {
    const r = await runSdk({
      skills: d.skills,
      config: configSchema.parse({}),
      arm,
      fixture: true,
      fixtureLoad: true,
      prompt: '修复代码',
      scores: { 'code-fix': 0.95 },
      oracle: ['code-fix'],
      provider: 'eval-fixture',
      model: 'fixture',
    })
    expect(r.result.finalResponse).toBe('offline-sdk-ok')
    const first = r.captures.find(c => c.type === 'request')!
    expect(first.type).toBe('request')
    if (first.type !== 'request') throw new Error('Missing request')
    expect(first.maxTokens).toBe(4096)
    controls.push(hash({ provider: first.provider, model: first.model, maxTokens: 4096, tools: first.tools }))
    const text = JSON.stringify(first.messages)
    for (const s of d.skills) expect(text).toContain(s.name)
    if (arm === 'A') {
      expect(visibleNames(r.captures, 'skill-auto-load-typesafe')).toEqual([])
      expect(r.audits).toHaveLength(0)
    }
    if (arm === 'B') {
      expect(visibleNames(r.captures, 'skill-auto-load-typesafe')).toEqual(['code-fix'])
      expect(text).toContain(d.skills[0]!.content)
      expect(text).toContain(join(r.workspace, '.eval-skills/code-fix'))
      expect(r.audits[0]?.loaded).toEqual(['code-fix'])
      expect(JSON.stringify(r.result.events)).toContain('skill-auto-load-typesafe')
    }
    if (arm === 'C') {
      expect(visibleNames(r.captures, 'eval-oracle')).toEqual(['code-fix'])
      expect(r.audits).toHaveLength(0)
      expect(text).toContain(d.skills[0]!.content)
    }
    expect(supplementalSkills(r.result.events)).toEqual(['code-fix'])
    expect(submittedSupplementalSkills(r.captures)).toEqual(['code-fix'])
    expect(r.captures.filter(c => c.type === 'request')).toHaveLength(4)
    expect(JSON.stringify(r.result.events)).toContain('Resources for code-fix.')
    expect(JSON.parse(await readFile(join(r.workspace, '.eval-skills/code-fix/smoke.json'), 'utf8'))).toEqual({
      verified: true,
    })
    const persistenceCtx = new Context()
    try {
      await persistenceCtx.plugin(JsonlSessionPersistence, { root: join(r.trial, 'home/sessions') })
      const handle = await persistenceCtx.sessionPersistence.open(SessionId(r.result.sessionId), 'read')
      const stored = await handle.read()
      const session = Session.create(SessionId(r.result.sessionId), stored.events, handle.header)
      expect(JSON.stringify(session.deriveMessages())).toContain('offline-sdk-ok')
      expect(JSON.stringify(session.deriveMessages())).toContain('Resources for code-fix.')
      await handle.close()
    } finally {
      await persistenceCtx.fiber.dispose()
    }
    const runtime = JSON.parse(await readFile(join(r.trial, 'runtime.json'), 'utf8'))
    expect(runtime).not.toHaveProperty('grader')
    expect(runtime).not.toHaveProperty('checks')
  }
  expect(new Set(controls).size).toBe(1)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('0.1.7-rc.1')
})

it('stops model requests when the SDK request budget is exhausted', async () => {
  const d = await loadDataset()
  try {
    const r = await runSdk({
      skills: d.skills,
      config: configSchema.parse({}),
      arm: 'A',
      fixture: true,
      fixtureLoad: true,
      fixtureRequestCap: 2,
      prompt: '修复代码',
      provider: 'eval-fixture',
      model: 'fixture',
    })
    expect(r.captures.filter(c => c.type === 'request')).toHaveLength(2)
    expect(r.captures.some(c => c.type === 'budget')).toBe(true)
  } catch (error) {
    const { SdkTrialError } = await import('../src/sdk-runner.js')
    expect(error).toBeInstanceOf(SdkTrialError)
    if (!(error instanceof SdkTrialError)) throw error
    expect(error.cancelled).toBe(true)
    const lines = (await readFile(join(error.trial, 'requests.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(s => JSON.parse(s))
    expect(lines.filter(c => c.type === 'request')).toHaveLength(2)
    expect(lines.some(c => c.type === 'budget')).toBe(true)
  }
})

it('honors caller cancellation and preserves isolated diagnostics', async () => {
  const d = await loadDataset()
  const controller = new AbortController()
  controller.abort()
  const { SdkTrialError } = await import('../src/sdk-runner.js')
  try {
    await runSdk({
      skills: d.skills,
      config: configSchema.parse({}),
      arm: 'A',
      fixture: true,
      signal: controller.signal,
      prompt: 'cancel',
      provider: 'eval-fixture',
      model: 'fixture',
    })
    throw new Error('Cancellation ignored')
  } catch (error) {
    expect(error).toBeInstanceOf(SdkTrialError)
    if (!(error instanceof SdkTrialError)) throw error
    expect(error.cancelled).toBe(true)
    expect(await readFile(join(error.trial, 'failure.json'), 'utf8')).toContain('cancelled')
  }
})
