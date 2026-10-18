import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeTextFile } from '../tauri/filesystem'
import { writePromptRunFile } from '../tauri/promptRun'
import { UNRESTRICTED_FLAG } from '../types'
import { clearClaudeWriterLocks } from './claudeWriterLock'
import { startPromptRun } from './startPromptRun'

vi.mock('../tauri/filesystem', () => ({
  writeTextFile: vi.fn(async () => {}),
}))

vi.mock('../tauri/promptRun', () => ({
  writePromptRunFile: vi.fn(async () => 'runs/run_api/api-reply.md'),
}))

const createAgentTerminal = vi.fn(async () => ({ id: 'term-1' }))

describe('startPromptRun', () => {
  beforeEach(() => {
    createAgentTerminal.mockReset()
    createAgentTerminal.mockImplementation(async () => ({ id: 'term-1' }))
  })

  afterEach(() => {
    clearClaudeWriterLocks()
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

  it('records a context hub path on the run', async () => {
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_hub',
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.contextDir).toMatch(/runs\/run_hub\/context$/)
  })

  it('creates one Claude session and points Codex at the context hub', async () => {
    let count = 0
    createAgentTerminal.mockImplementation(async (_projectId, args) => ({
      id: `term-${++count}`,
      sessionId: args.firstTab.sessionId,
    }))
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login and generate unit tests',
      unrestricted: false,
      enabledAgents: ['claude', 'codex'],
      installedAgents: ['claude', 'codex'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      includeOrchestrator: false,
      createId: () => 'run_duo',
      createUuid: () => 'sess-canonical',
      lanes: [
        {
          agent: 'claude',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'implement login',
        },
        {
          agent: 'codex',
          role: 'worker',
          taskKind: 'mechanical',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'write tests',
        },
      ],
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const claudeCall = createAgentTerminal.mock.calls[0][1]
    const codexCall = createAgentTerminal.mock.calls[1][1]
    expect(claudeCall.firstTab.type).toBe('claude')
    expect(claudeCall.firstTab.sessionId).toBe('sess-canonical')
    expect(claudeCall.firstTab.sessionCreate).toBe(true)
    expect(codexCall.firstTab.type).toBe('codex')
    expect(codexCall.firstTab.initialInput).toContain('runs/run_duo/context')
    expect(codexCall.firstTab.initialInput.length).toBeLessThan(2000)
    expect(result.run.canonicalClaudeSessionId).toBe('sess-canonical')
    expect(result.run.canonicalClaudeTerminalId).toBe('term-1')
  })

  it('runs an api lane via chat without spawning a PTY', async () => {
    const chat = vi.fn(async () => ({ text: 'assistant reply' }))
    const writeApiReply = vi.fn(async () => {})
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: [],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_api',
      now: () => 1_700_000_000_000,
      lanes: [
        {
          agent: 'api:google',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'implement login',
        },
      ],
      chat,
      pickCodingModel: () => 'gemini-2.5-pro',
      writeApiReply,
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(createAgentTerminal).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
    expect(chat.mock.calls[0]?.[0]).toBe('google')
    expect(chat.mock.calls[0]?.[1]).toBe('gemini-2.5-pro')
    expect(chat.mock.calls[0]?.[3]).toBe(120000)
    expect(writeApiReply).toHaveBeenCalledOnce()
    expect(writeApiReply.mock.calls[0]?.[0]).toMatch(/api-reply\.md$/)
    expect(writeApiReply.mock.calls[0]?.[1]).toBe('assistant reply')
    if (!result.ok) return
    expect(result.run.status).toBe('done')
    expect(result.run.activeAgent).toBe('api:google')
    expect(result.run.steps[0]?.terminalId).toBe('api:google:run_api')
    expect(result.run.steps[0]?.endedAt).toBe(1_700_000_000_000)
  })

  it('writes api-reply.md through writePromptRunFile when writeApiReply is omitted', async () => {
    const chat = vi.fn(async () => ({ text: 'assistant reply' }))
    vi.mocked(writePromptRunFile).mockClear()
    vi.mocked(writeTextFile).mockClear()
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: [],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_api_default',
      now: () => 1_700_000_000_000,
      lanes: [
        {
          agent: 'api:google',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'implement login',
        },
      ],
      chat,
      pickCodingModel: () => 'gemini-2.5-pro',
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(writePromptRunFile).toHaveBeenCalledWith('run_api_default', 'api-reply.md', 'assistant reply')
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('does not treat a completed api run as still blocking the project', async () => {
    const chat = vi.fn(async () => ({ text: 'assistant reply' }))
    const writeApiReply = vi.fn(async () => {})
    const first = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: [],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_api',
      now: () => 1_700_000_000_000,
      lanes: [
        {
          agent: 'api:google',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'implement login',
        },
      ],
      chat,
      pickCodingModel: () => 'gemini-2.5-pro',
      writeApiReply,
      createAgentTerminal,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'write tests',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      activeRunStatus: first.run.status,
      activeRunTerminalIds: first.run.steps.map((step) => step.terminalId ?? ''),
      createId: () => 'run_next',
      createAgentTerminal,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.run.id).toBe('run_next')
  })

  it('keeps a mixed cli+api start running and ends only the api step', async () => {
    const chat = vi.fn(async () => ({ text: 'assistant reply' }))
    const writeApiReply = vi.fn(async () => {})
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login and review it',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      createId: () => 'run_mix',
      now: () => 1_700_000_000_000,
      lanes: [
        {
          agent: 'claude',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'implement login',
        },
        {
          agent: 'api:google',
          role: 'worker',
          taskKind: 'review',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'review login',
        },
      ],
      chat,
      pickCodingModel: () => 'gemini-2.5-pro',
      writeApiReply,
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.status).toBe('running')
    expect(result.run.steps[0]?.terminalId).toBe('term-1')
    expect(result.run.steps[0]?.endedAt).toBeUndefined()
    expect(result.run.steps[1]?.terminalId).toBe('api:google:run_mix')
    expect(result.run.steps[1]?.endedAt).toBe(1_700_000_000_000)
  })
})
