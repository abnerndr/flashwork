import { describe, expect, it } from 'vitest'

import { planAutoLanes, type PlanAutoLanesInput } from './planAutoLanes'

const BASE: PlanAutoLanesInput = {
  prompt: 'implement login',
  enabledAgents: ['claude', 'codex', 'opencode', 'freebuff'],
  installedAgents: ['claude', 'codex', 'opencode', 'freebuff'],
  claudeFiveHourUtilization: 10,
  codexRateLimited: false,
  lastUsedAgent: 'claude',
}

describe('planAutoLanes', () => {
  it('keeps a simple prompt on a single worker when only one CLI is installed', () => {
    const lanes = planAutoLanes({
      ...BASE,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
    })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ role: 'worker', agent: 'claude', taskKind: 'implement' })
  })

  it('keeps a simple implement prompt on a single worker even when more CLIs are installed', () => {
    const lanes = planAutoLanes({
      ...BASE,
      enabledAgents: ['claude', 'gemini', 'codex'],
      installedAgents: ['claude', 'gemini', 'codex'],
    })
    const workers = lanes.filter((lane) => lane.role === 'worker')
    expect(workers).toHaveLength(1)
    expect(workers[0]).toMatchObject({ agent: 'claude', taskKind: 'implement' })
    expect(lanes.every((lane) => lane.role === 'worker')).toBe(true)
  })

  it('splits implement and tests across agents and adds a free orchestrator', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login and generate unit tests for the parser',
    })
    const workers = lanes.filter((lane) => lane.role === 'worker')
    const orchestrator = lanes.find((lane) => lane.role === 'orchestrator')
    expect(workers.map((lane) => lane.taskKind).sort()).toEqual(['implement', 'mechanical'])
    expect(new Set(workers.map((lane) => lane.agent)).size).toBe(2)
    expect(orchestrator?.agent).toBe('freebuff')
    expect(lanes[0]?.role).toBe('orchestrator')
  })

  it('assigns matching skills to the agents that have them', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'use playwright coverage and the brand skill on the new landing page',
      skills: [
        { name: 'playwright', description: 'Browser tests', agents: ['codex'] },
        { name: 'brand', description: 'Visual identity', agents: ['claude'] },
      ],
    })
    const workers = lanes.filter((lane) => lane.role === 'worker')
    expect(workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: 'codex', skillNames: ['playwright'], reason: 'skill' }),
        expect.objectContaining({ agent: 'claude', skillNames: ['brand'], reason: 'skill' }),
      ]),
    )
  })

  it('does not invent an orchestrator when only one worker is needed', () => {
    const lanes = planAutoLanes({
      ...BASE,
      installedAgents: ['claude'],
      enabledAgents: ['claude'],
      prompt: 'implement login and generate unit tests',
    })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.role).toBe('worker')
  })

  it('omits the orchestrator pane when includeOrchestrator is false', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login and generate unit tests for the parser',
      includeOrchestrator: false,
    })
    expect(lanes.every((lane) => lane.role === 'worker')).toBe(true)
    expect(lanes.some((lane) => lane.role === 'orchestrator')).toBe(false)
  })

  it('does not clone the same implement slice onto Gemini and Codex', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login',
      enabledAgents: ['claude', 'gemini', 'codex'],
      installedAgents: ['claude', 'gemini', 'codex'],
      includeOrchestrator: false,
    })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ agent: 'claude', role: 'worker', taskKind: 'implement' })
  })

  it('names sibling owners in each worker prompt so they do not redo each other', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login and generate unit tests for the parser',
      includeOrchestrator: false,
    })
    const implement = lanes.find((lane) => lane.taskKind === 'implement')
    const mechanical = lanes.find((lane) => lane.taskKind === 'mechanical')
    expect(implement?.slicePrompt).toContain('implementation')
    expect(implement?.slicePrompt).toMatch(/tests and mechanical/i)
    expect(mechanical?.slicePrompt).toMatch(/implementation/i)
    expect(implement?.slicePrompt).not.toEqual(mechanical?.slicePrompt)
  })

  it('assigns Antigravity to UI work', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'restyle the settings screen',
      enabledAgents: ['claude', 'antigravity', 'gemini'],
      installedAgents: ['claude', 'antigravity', 'gemini'],
      includeOrchestrator: false,
    })
    expect(lanes.some((lane) => lane.agent === 'antigravity' && lane.taskKind === 'ui')).toBe(true)
  })

  it('stays on a single worker when only one CLI is installed', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login',
      enabledAgents: ['gemini'],
      installedAgents: ['gemini'],
    })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.agent).toBe('gemini')
  })

  it('never emits two Claude workers', () => {
    const lanes = planAutoLanes({
      ...BASE,
      prompt: 'implement login and generate unit tests for the parser and review the auth flow',
      enabledAgents: ['claude', 'codex'],
      installedAgents: ['claude', 'codex'],
      includeOrchestrator: false,
    })
    expect(lanes.filter((lane) => lane.agent === 'claude')).toHaveLength(1)
  })
})
