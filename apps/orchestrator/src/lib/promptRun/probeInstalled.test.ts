import { describe, expect, it, vi, beforeEach } from 'vitest'

import { clearInstalledAgentCache, probeInstalledAgents } from './probeInstalled'

vi.mock('../tauri', () => ({
  findCliLauncher: vi.fn(async (command: string) =>
    command === 'claude' || command === 'gemini' ? `/bin/${command}` : null,
  ),
  detectAgentsForCwd: vi.fn(async (_cwd: string, agents: string[]) =>
    agents.map((agent) => ({
      agent,
      installed: agent === 'codex' || agent === 'agy',
      path: null,
      version: null,
      wslDistro: 'Ubuntu',
    })),
  ),
}))

import { detectAgentsForCwd, findCliLauncher } from '../tauri'

describe('probeInstalledAgents', () => {
  beforeEach(() => {
    clearInstalledAgentCache()
    vi.mocked(findCliLauncher).mockClear()
    vi.mocked(detectAgentsForCwd).mockClear()
  })

  it('probes launchers in parallel and caches the result', async () => {
    const first = await probeInstalledAgents(['claude', 'gemini', 'codex'])
    const second = await probeInstalledAgents(['claude', 'gemini', 'codex'])
    expect(first).toEqual(['claude', 'gemini'])
    expect(second).toEqual(['claude', 'gemini'])
    expect(findCliLauncher).toHaveBeenCalledTimes(3)
    expect(detectAgentsForCwd).not.toHaveBeenCalled()
  })

  it('detects per cwd in one call and maps CLI names back to agents', async () => {
    const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\u\\p'
    const found = await probeInstalledAgents(['claude', 'codex', 'antigravity', 'shell'], cwd)
    expect(found).toEqual(['codex', 'antigravity'])
    expect(detectAgentsForCwd).toHaveBeenCalledTimes(1)
    expect(detectAgentsForCwd).toHaveBeenCalledWith(cwd, ['claude', 'codex', 'agy'])
    expect(findCliLauncher).not.toHaveBeenCalled()
  })

  it('caches per cwd', async () => {
    await probeInstalledAgents(['claude'])
    await probeInstalledAgents(['claude'], '/home/u/p')
    expect(findCliLauncher).toHaveBeenCalledTimes(1)
    expect(detectAgentsForCwd).toHaveBeenCalledTimes(1)
  })
})
