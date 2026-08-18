import { describe, expect, it } from 'vitest'

import { selectAgent, type SelectAgentInput } from './selectAgent'

const BASE: SelectAgentInput = {
  prompt: 'implement login',
  enabledAgents: ['claude', 'codex', 'opencode'],
  installedAgents: ['claude', 'codex', 'opencode'],
  claudeFiveHourUtilization: 10,
  codexRateLimited: false,
  lastUsedAgent: 'claude',
}

describe('selectAgent', () => {
  it('returns the only installed agent', () => {
    const choice = selectAgent({
      ...BASE,
      enabledAgents: ['claude', 'codex'],
      installedAgents: ['codex'],
    })
    expect(choice).toEqual({
      agent: 'codex',
      reason: 'only-installed',
      taskKind: 'implement',
    })
  })

  it('uses the project review provider for review tasks', () => {
    const choice = selectAgent({
      ...BASE,
      prompt: 'review this PR',
      reviewAgentProvider: 'codex',
    })
    expect(choice.agent).toBe('codex')
    expect(choice.reason).toBe('project-preference')
    expect(choice.taskKind).toBe('review')
  })

  it('skips Claude when 5h utilization is at least 80', () => {
    const choice = selectAgent({
      ...BASE,
      prompt: 'implement a cache',
      claudeFiveHourUtilization: 82,
    })
    expect(choice.agent).toBe('codex')
    expect(choice.reason).toBe('quota')
  })

  it('picks Claude for implement when quota is fine', () => {
    const choice = selectAgent(BASE)
    expect(choice.agent).toBe('claude')
    expect(choice.reason).toBe('heuristic')
  })

  it('picks Codex or OpenCode for mechanical work', () => {
    const choice = selectAgent({ ...BASE, prompt: 'generate unit tests for the parser' })
    expect(['codex', 'opencode']).toContain(choice.agent)
    expect(choice.reason).toBe('heuristic')
  })

  it('falls back to last used when the heuristic ties on unknown', () => {
    const choice = selectAgent({
      ...BASE,
      prompt: 'hello there',
      lastUsedAgent: 'opencode',
    })
    expect(choice.agent).toBe('opencode')
    expect(choice.reason).toBe('last-used')
  })

  it('returns null when nothing is installed', () => {
    expect(selectAgent({ ...BASE, installedAgents: [] })).toBeNull()
  })

  it('ignores enabled agents that are not installed', () => {
    const choice = selectAgent({
      ...BASE,
      enabledAgents: ['claude'],
      installedAgents: ['codex'],
    })
    expect(choice?.agent).toBe('codex')
  })
})
