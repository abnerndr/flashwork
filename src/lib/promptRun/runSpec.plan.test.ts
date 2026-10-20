import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../types'
import { resetDeepseekPlannerAvailability } from './deepseekPlanner'
import { SPEC_PLANNER_TIMEOUT_MS, planSpec, type PlanSpecDeps } from './runSpec'

const PLAN = JSON.stringify({
  tasks: [
    {
      id: 't1',
      title: 'API',
      prompt: 'Add the login endpoint',
      files: ['server/'],
      kind: 'implement',
      agent: 'claude',
    },
  ],
})

const project = { id: 'p1', terminals: [] as Array<{ id: string; tabs: Array<{ type: AgentType }> }> }
const agents: AgentType[] = ['claude', 'codex']

function deps(overrides: Partial<PlanSpecDeps> = {}): PlanSpecDeps {
  return {
    usableAgents: async () => agents,
    keyStatus: async () => ({ saved: true }),
    chat: vi.fn(async () => ({ text: PLAN })),
    gemini: vi.fn(async () => ({ text: PLAN })),
    ...overrides,
  }
}

describe('planSpec DeepSeek order', () => {
  beforeEach(() => {
    resetDeepseekPlannerAvailability()
  })

  it('calls DeepSeek before Gemini when a key is saved', async () => {
    const planned = deps()
    const result = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      planned,
    )
    expect(result).toMatchObject({ ok: true, source: 'deepseek' })
    expect(planned.chat).toHaveBeenCalledWith(
      'deepseek',
      'deepseek-flash',
      [{ role: 'user', content: expect.stringContaining('Review the README') }],
      SPEC_PLANNER_TIMEOUT_MS,
    )
    expect(planned.gemini).not.toHaveBeenCalled()
  })

  it('picks the coder model for an implementation-heavy SPEC', async () => {
    const spec = [
      'Implement the login API and the session store.',
      'Add unit tests for the auth component.',
      'Refactor token refresh so expired sessions redirect to the login screen.',
    ].join('\n')
    const planned = deps()
    const result = await planSpec({ project, cwd: '/repo', spec }, planned)
    expect(result).toMatchObject({ ok: true, source: 'deepseek' })
    expect(planned.chat).toHaveBeenCalledWith(
      'deepseek',
      'deepseek-v4-pro',
      expect.any(Array),
      SPEC_PLANNER_TIMEOUT_MS,
    )
  })

  it('plans only with the CLIs the user turned on', async () => {
    const planned = deps()
    const result = await planSpec(
      {
        project,
        cwd: '/repo',
        spec: 'Review the README and summarize the architecture.',
        allowedAgents: ['codex'],
      },
      {
        ...planned,
        usableAgents: async () => ['claude', 'codex'],
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.agents).toEqual(['codex'])
    expect(result.tasks.every((task) => task.agent === 'codex' || task.agent === 'shell')).toBe(true)
  })

  it('does not call DeepSeek when no key is saved', async () => {
    const planned = deps({ keyStatus: async () => ({ saved: false }) })
    const result = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      planned,
    )
    expect(planned.chat).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, source: 'gemini' })
  })

  it('falls through to Gemini and skips DeepSeek for the rest of the session after a failed call', async () => {
    const failing = deps({
      chat: vi.fn(async () => {
        throw new Error('provider_unauthorized')
      }),
    })
    const first = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      failing,
    )
    expect(first).toMatchObject({ ok: true, source: 'gemini' })
    expect(failing.chat).toHaveBeenCalledOnce()

    const later = deps()
    const second = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      later,
    )
    expect(later.chat).not.toHaveBeenCalled()
    expect(second).toMatchObject({ ok: true, source: 'gemini' })
  })

  it('marks an unusable DeepSeek reply unavailable and falls through to Gemini', async () => {
    const planned = deps({ chat: vi.fn(async () => ({ text: 'I cannot help with that' })) })
    const result = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      planned,
    )
    expect(result).toMatchObject({ ok: true, source: 'gemini' })

    const later = deps()
    await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      later,
    )
    expect(later.chat).not.toHaveBeenCalled()
  })

  it('keeps Gemini then the local heuristic when DeepSeek has no key and Gemini fails', async () => {
    const planned = deps({
      keyStatus: async () => ({ saved: false }),
      gemini: vi.fn(async () => ({ notice: 'gemini-missing' as const })),
    })
    const result = await planSpec(
      { project, cwd: '/repo', spec: 'Review the README and summarize the architecture.' },
      planned,
    )
    expect(result).toMatchObject({ ok: true, source: 'heuristic', notice: 'gemini-missing' })
    expect(planned.chat).not.toHaveBeenCalled()
  })
})
