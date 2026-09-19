import { afterEach, describe, expect, it, vi } from 'vitest'

import { routeOpenTask, routeTask } from './routeTask'

describe('routeTask', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls back to classifyTask when no remote router', async () => {
    const out = await routeTask({
      prompt: 'restyle the login modal',
      enabledAgents: ['claude', 'antigravity'],
      installedAgents: ['claude', 'antigravity'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => null,
    })
    expect(out.taskKind).toBe('ui')
    expect(out.agent).toBe('antigravity')
    expect(out.source).toBe('fallback')
  })

  it('accepts schema-valid JSON from probe and ignores extra keys', async () => {
    const out = await routeTask({
      prompt: 'anything',
      enabledAgents: ['codex'],
      installedAgents: ['codex'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'mechanical', agent: 'codex', reason: 'tests' }),
    })
    expect(out.agent).toBe('codex')
    expect(out.taskKind).toBe('mechanical')
    expect(out.source).toBe('probe')
  })

  it('ignores probe agents that are not installed', async () => {
    const out = await routeTask({
      prompt: 'implement login',
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'gemini', reason: 'x' }),
    })
    expect(out.agent).toBe('claude')
  })

  it('falls back when probe throws', async () => {
    const out = await routeTask({
      prompt: 'restyle the login modal',
      enabledAgents: ['claude', 'antigravity'],
      installedAgents: ['claude', 'antigravity'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => {
        throw new Error('probe failed')
      },
    })
    expect(out.taskKind).toBe('ui')
    expect(out.agent).toBe('antigravity')
  })

  it('falls back when probe times out', async () => {
    vi.useFakeTimers()
    const pending = routeTask({
      prompt: 'restyle the login modal',
      enabledAgents: ['claude', 'antigravity'],
      installedAgents: ['claude', 'antigravity'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: () => new Promise(() => {}),
    })
    await vi.advanceTimersByTimeAsync(2500)
    const out = await pending
    expect(out.taskKind).toBe('ui')
    expect(out.agent).toBe('antigravity')
  })

  it('falls back when probe kind is invalid', async () => {
    const out = await routeTask({
      prompt: 'restyle the login modal',
      enabledAgents: ['claude', 'antigravity'],
      installedAgents: ['claude', 'antigravity'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'not-a-kind', agent: 'antigravity' }),
    })
    expect(out.taskKind).toBe('ui')
    expect(out.agent).toBe('antigravity')
  })

  it('rejects api:google when a coding CLI is installed and uses selectAgent', async () => {
    const out = await routeTask({
      prompt: 'implement login',
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'api:google', reason: 'x' }),
    })
    expect(out.agent).toBe('claude')
    expect(out.taskKind).toBe('implement')
    expect(out.source).toBe('fallback')
  })

  it('accepts api:google when no coding CLI is installed', async () => {
    const out = await routeTask({
      prompt: 'implement login',
      enabledAgents: [],
      installedAgents: [],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'api:google', reason: 'x' }),
    })
    expect(out?.agent).toBe('api:google')
    expect(out?.taskKind).toBe('implement')
    expect(out?.source).toBe('probe')
  })
})

describe('routeOpenTask', () => {
  it('keeps a probed api:google when that provider has a saved key', async () => {
    const out = await routeOpenTask({
      prompt: 'implement login',
      enabledAgents: [],
      installedAgents: [],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'api:google' }),
      keyStatus: async (id) => ({ saved: id === 'google' }),
    })
    expect(out).toMatchObject({
      ok: true,
      agent: 'api:google',
      source: 'probe',
    })
  })

  it('synthesizes api:openai when the probe picked api:google without a google key', async () => {
    const out = await routeOpenTask({
      prompt: 'implement login',
      enabledAgents: [],
      installedAgents: [],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'api:google' }),
      keyStatus: async (id) => ({ saved: id === 'openai' }),
    })
    expect(out).toMatchObject({
      ok: true,
      agent: 'api:openai',
    })
  })

  it('drops a probed api:google with no saved key and no CLI', async () => {
    const out = await routeOpenTask({
      prompt: 'implement login',
      enabledAgents: [],
      installedAgents: [],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => ({ kind: 'implement', agent: 'api:google' }),
      keyStatus: async () => ({ saved: false }),
    })
    expect(out).toEqual({ ok: false, needsSetup: 'cli' })
  })
})
