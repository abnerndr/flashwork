import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: vi.fn(),
  },
}))

vi.mock('../stores/terminalsStore', () => ({
  useTerminalsStore: {
    getState: vi.fn(),
  },
}))

vi.mock('./agentRuntimeAdapter', () => ({
  preparePtyRuntimeLaunch: (_agent: string, _profile: unknown, args: string[]) => ({
    args,
    env: {},
  }),
}))

vi.mock('./providers/envForCli', () => ({
  providerSpawnFlags: () => ({}),
}))

vi.mock('./spawnQueue', () => ({
  acquireSpawnSlot: vi.fn(async () => true),
  releaseSpawnSlot: vi.fn(),
}))

vi.mock('./tauri', () => ({
  getPtyCwd: vi.fn(),
  restartPty: vi.fn(async () => undefined),
  snapshotAntigravitySessions: vi.fn(async () => []),
  snapshotClaudeSessions: vi.fn(async () => []),
  snapshotCodexSessions: vi.fn(async () => []),
  snapshotGeminiSessions: vi.fn(async () => []),
  snapshotOpenCodeSessions: vi.fn(async () => []),
}))

vi.mock('./sessionResume', () => ({
  getActiveSessions: vi.fn(() => ({})),
  saveSession: vi.fn(),
}))

import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { countLiveResumablePanes, resetLastSession } from './resetLastSession'
import { getActiveSessions, saveSession } from './sessionResume'
import {
  restartPty,
  snapshotCodexSessions,
  snapshotGeminiSessions,
} from './tauri'

describe('resetLastSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useProjectsStore.getState).mockReturnValue({
      preferences: {},
      projects: [
        {
          id: 'proj',
          terminals: [
            {
              id: 'term',
              cwd: '/repo',
              disabled: false,
              tabs: [
                {
                  id: 'tab-gemini',
                  type: 'gemini',
                  ptyId: 'pty-g',
                  cwd: '/repo',
                  extraArgs: ['--yolo'],
                },
                {
                  id: 'tab-codex',
                  type: 'codex',
                  ptyId: 'pty-c',
                  cwd: '/repo',
                  extraArgs: [],
                },
                {
                  id: 'tab-agy',
                  type: 'antigravity',
                  ptyId: 'pty-a',
                  cwd: '/repo',
                  extraArgs: [],
                },
              ],
            },
          ],
        },
      ],
      setSubTabSessionId: vi.fn(),
    } as never)
    vi.mocked(useTerminalsStore.getState).mockReturnValue({
      byPtyId: {
        'pty-g': { alive: true },
        'pty-c': { alive: true },
        'pty-a': { alive: true },
      },
      beginRestart: vi.fn(),
    } as never)
  })

  it('counts gemini panes as resumable', () => {
    expect(countLiveResumablePanes()).toBe(3)
  })

  it('resumes gemini with --resume uuid and antigravity via agy', async () => {
    vi.mocked(snapshotGeminiSessions).mockResolvedValue([
      { id: 'gem-1', modified_at_ms: 200, size_bytes: 10 },
    ] as never)
    vi.mocked(snapshotCodexSessions).mockResolvedValue([
      { id: 'cod-1', modified_at_ms: 200, size_bytes: 10 },
    ] as never)
    vi.mocked(getActiveSessions).mockReturnValue({})

    const { resumed, total } = await resetLastSession()
    expect(total).toBe(3)
    expect(resumed).toBe(3)

    const calls = vi.mocked(restartPty).mock.calls.map((call) => call[0])
    expect(calls.find((c) => c.command === 'gemini')?.extraArgs).toEqual([
      '--resume',
      'gem-1',
      '--yolo',
    ])
    expect(calls.find((c) => c.command === 'codex')?.extraArgs).toEqual(['resume', 'cod-1'])
    expect(calls.find((c) => c.command === 'agy')?.extraArgs).toEqual(['--continue'])

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith(
      'tab-gemini',
      expect.objectContaining({ geminiSessionId: 'gem-1', agent: 'gemini' }),
    )
  })
})
