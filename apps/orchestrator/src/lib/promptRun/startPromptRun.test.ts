import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UNRESTRICTED_FLAG } from '../types'
import { startPromptRun } from './startPromptRun'

const createAgentTerminal = vi.fn(async () => ({ id: 'term-1' }))

describe('startPromptRun', () => {
  beforeEach(() => {
    createAgentTerminal.mockClear()
  })

  it('refuses when there is no project', async () => {
    const result = await startPromptRun({
      project: null,
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createAgentTerminal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-project')
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })

  it('refuses when a run is already active', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App', reviewAgentProvider: 'claude', conflictAgentProvider: 'claude' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      activeRunStatus: 'running',
      createAgentTerminal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('run-active')
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })

  it('returns needs-install when no CLI is present', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: [],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createAgentTerminal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('needs-install')
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })

  it('creates a terminal with run bootstrap text', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: true,
      enabledAgents: ['claude', 'codex'],
      installedAgents: ['claude', 'codex'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_test',
      now: () => 1_700_000_000_000,
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(createAgentTerminal).toHaveBeenCalledOnce()
    expect(createAgentTerminal).toHaveBeenCalledWith('p1', expect.objectContaining({ cwd: '/tmp/app' }))
    const args = createAgentTerminal.mock.calls[0][1]
    expect(args.firstTab.type).toBe('claude')
    expect(args.firstTab.initialInput).toContain('implement login')
    expect(args.firstTab.initialInput).toContain('run_test')
    expect(args.firstTab.initialInput).not.toContain('runs/run_test/journal.md')
    expect(args.firstTab.initialInput).not.toMatch(/runs\/[^/\s]+\/journal\.md/)
    expect(args.firstTab.extraArgs).toEqual([UNRESTRICTED_FLAG.claude])
    if (!result.ok) return
    expect(result.run).toMatchObject({
      id: 'run_test',
      status: 'running',
      projectId: 'p1',
      unrestricted: true,
      activeTerminalId: 'term-1',
    })
    expect(result.run.steps[0]?.reason).toBe('heuristic')
  })
})
