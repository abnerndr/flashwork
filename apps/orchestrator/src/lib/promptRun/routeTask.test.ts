import { afterEach, describe, expect, it, vi } from 'vitest'

import { routeTask } from './routeTask'

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
})
