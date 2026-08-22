import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UNRESTRICTED_FLAG } from '../types'
import { startPromptRun } from './startPromptRun'

const createAgentTerminal = vi.fn(async () => ({ id: 'term-1' }))

describe('startPromptRun', () => {
  beforeEach(() => {
    createAgentTerminal.mockReset()
    createAgentTerminal.mockImplementation(async () => ({ id: 'term-1' }))
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
      activeTerminalId: 'term-live',
      liveTerminalIds: ['term-live'],
      createAgentTerminal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('run-active')
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })

  it('refuses when live terminals are unknown and a run is marked running', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      activeRunStatus: 'running',
      activeTerminalId: 'term-live',
      createAgentTerminal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('run-active')
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })

  it('starts when a persisted run is running but its pane is gone', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      activeRunStatus: 'running',
      activeTerminalId: 'term-gone',
      liveTerminalIds: ['term-other'],
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(createAgentTerminal).toHaveBeenCalledOnce()
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
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
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
    expect(result.run.steps[0]?.reason).toBe('only-installed')
  })

  it('opens a pane for each work slice', async () => {
    let count = 0
    createAgentTerminal.mockImplementation(async () => ({ id: `term-${++count}` }))
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login and generate unit tests for the parser',
      unrestricted: false,
      enabledAgents: ['claude', 'codex', 'freebuff'],
      installedAgents: ['claude', 'codex', 'freebuff'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(createAgentTerminal.mock.calls.length).toBeGreaterThanOrEqual(2)
    if (!result.ok) return
    expect(result.run.steps.length).toBeGreaterThanOrEqual(2)
    expect(new Set(result.run.steps.map((step) => step.agent)).size).toBeGreaterThanOrEqual(2)
  })

  it('starts board workers without an orchestrator TUI', async () => {
    let count = 0
    createAgentTerminal.mockImplementation(async () => ({ id: `term-${++count}` }))
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login and generate unit tests for the parser',
      unrestricted: false,
      enabledAgents: ['claude', 'codex', 'freebuff'],
      installedAgents: ['claude', 'codex', 'freebuff'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      includeOrchestrator: false,
      allowedFiles: ['src/login.ts'],
      boardPath: '/tmp/board.md',
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    const agents = createAgentTerminal.mock.calls.map((call) => call[1].firstTab.type)
    expect(agents).not.toContain('freebuff')
    expect(createAgentTerminal.mock.calls[0][1].firstTab.initialInput).toContain('src/login.ts')
    expect(createAgentTerminal.mock.calls[0][1].firstTab.initialInput).toContain('/tmp/board.md')
  })

  it('does not open Gemini and Codex to clone the same implement job', async () => {
    let count = 0
    createAgentTerminal.mockImplementation(async () => ({ id: `term-${++count}` }))
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude', 'gemini', 'codex'],
      installedAgents: ['claude', 'gemini', 'codex'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      includeOrchestrator: false,
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(createAgentTerminal).toHaveBeenCalledOnce()
    expect(createAgentTerminal.mock.calls[0][1].firstTab.type).toBe('claude')
  })
})
