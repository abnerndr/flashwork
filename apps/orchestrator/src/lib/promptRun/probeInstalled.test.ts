import { describe, expect, it, vi, beforeEach } from 'vitest'

import { clearInstalledAgentCache, probeInstalledAgents } from './probeInstalled'

vi.mock('../tauri', () => ({
  findCliLauncher: vi.fn(async (command: string) =>
    command === 'claude' || command === 'gemini' ? `/bin/${command}` : null,
  ),
}))

import { findCliLauncher } from '../tauri'

describe('probeInstalledAgents', () => {
  beforeEach(() => {
    clearInstalledAgentCache()
    vi.mocked(findCliLauncher).mockClear()
  })

  it('probes launchers in parallel and caches the result', async () => {
    const first = await probeInstalledAgents(['claude', 'gemini', 'codex'])
    const second = await probeInstalledAgents(['claude', 'gemini', 'codex'])
    expect(first).toEqual(['claude', 'gemini'])
    expect(second).toEqual(['claude', 'gemini'])
    expect(findCliLauncher).toHaveBeenCalledTimes(3)
  })
})
