import { describe, expect, it, vi } from 'vitest'

import type { ProviderId } from '../providers/modelCatalog'
import { freeProbe, routeOpenTask } from './freeRouter'

function keyStatusFor(saved: Partial<Record<ProviderId, boolean>>) {
  return vi.fn(async (id: ProviderId) => ({ saved: Boolean(saved[id]) }))
}

describe('freeProbe', () => {
  it('returns null and does not call chat when no keys are saved', async () => {
    const chat = vi.fn(async () => ({ text: '{"kind":"implement","agent":"claude","reason":"x"}' }))
    const out = await freeProbe(
      { prompt: 'implement login', installedAgents: ['claude'] },
      { keyStatus: keyStatusFor({}), chat },
    )
    expect(out).toBeNull()
    expect(chat).not.toHaveBeenCalled()
  })

  it('uses google when both google and openai keys are saved', async () => {
    const chat = vi.fn(async () => ({
      text: '{"kind":"implement","agent":"claude","reason":"x"}',
    }))
    await freeProbe(
      { prompt: 'implement login', installedAgents: ['claude'] },
      {
        keyStatus: keyStatusFor({ google: true, openai: true }),
        chat,
        pickRouterModel: () => 'router-model',
      },
    )
    expect(chat).toHaveBeenCalledOnce()
    expect(chat.mock.calls[0]?.[0]).toBe('google')
    expect(chat.mock.calls[0]?.[1]).toBe('router-model')
    expect(chat.mock.calls[0]?.[3]).toBe(2500)
  })

  it('uses openai when google is unsaved', async () => {
    const chat = vi.fn(async () => ({
      text: '{"kind":"mechanical","agent":"codex","reason":"x"}',
    }))
    await freeProbe(
      { prompt: 'generate unit tests', installedAgents: ['codex'] },
      {
        keyStatus: keyStatusFor({ openai: true }),
        chat,
        pickRouterModel: () => 'gpt-router',
      },
    )
    expect(chat.mock.calls[0]?.[0]).toBe('openai')
  })

  it('returns null when chat text is not JSON', async () => {
    const chat = vi.fn(async () => ({ text: 'not json at all' }))
    const out = await freeProbe(
      { prompt: 'implement login', installedAgents: ['claude'] },
      {
        keyStatus: keyStatusFor({ google: true }),
        chat,
        pickRouterModel: () => 'router-model',
      },
    )
    expect(out).toBeNull()
  })
})

describe('routeOpenTask', () => {
  it("returns needsSetup 'cli' when no CLI and no key", async () => {
    const out = await routeOpenTask({
      prompt: 'implement login',
      enabledAgents: [],
      installedAgents: [],
      claudeFiveHourUtilization: null,
      codexRateLimited: false,
      probe: async () => null,
      keyStatus: async () => ({ saved: false }),
    })
    expect(out).toEqual({ ok: false, needsSetup: 'cli' })
  })
})
