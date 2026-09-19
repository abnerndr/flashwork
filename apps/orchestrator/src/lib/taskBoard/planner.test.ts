import { describe, expect, it } from 'vitest'

import { heuristicBoardSlices, parsePlannerSlices, planBoardSlices, serializeSiblingSlices } from './planner'

const BASE = {
  prompt: 'implement login and review the auth flow',
  enabledAgents: ['claude', 'gemini', 'codex'] as const,
  installedAgents: ['claude', 'gemini', 'codex'] as const,
  claudeFiveHourUtilization: 10,
  codexRateLimited: false,
  allowedFiles: ['src/auth.ts'],
}

describe('parsePlannerSlices', () => {
  it('reads a JSON object even when wrapped in prose', () => {
    const slices = parsePlannerSlices(
      'Sure.\n{"slices":[{"kind":"implement","agent":"claude","prompt":"write login","allowedFiles":["src/auth.ts"],"dependsOn":[]}]}\n',
      { ...BASE },
    )
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({
      kind: 'implement',
      agent: 'claude',
      prompt: 'write login',
      allowedFiles: ['src/auth.ts'],
    })
  })

  it('returns empty when the payload is not JSON', () => {
    expect(parsePlannerSlices('not json', { ...BASE })).toEqual([])
  })

  it('remaps an unknown agent onto an installed CLI', () => {
    const slices = parsePlannerSlices(
      JSON.stringify({
        slices: [{ kind: 'implement', agent: 'not-a-cli', prompt: 'build it' }],
      }),
      { ...BASE },
    )
    expect(slices).toHaveLength(1)
    expect(['claude', 'gemini', 'codex']).toContain(slices[0]?.agent)
  })

  it('remaps UI slices onto Antigravity when it is installed', () => {
    const slices = parsePlannerSlices(
      JSON.stringify({
        slices: [{ kind: 'ui', agent: 'gemini', prompt: 'restyle settings' }],
      }),
      { ...BASE, installedAgents: ['claude', 'gemini', 'antigravity'], enabledAgents: ['claude', 'gemini', 'antigravity'] },
    )
    expect(slices[0]).toMatchObject({ kind: 'ui', agent: 'antigravity' })
  })
})

describe('planBoardSlices', () => {
  it('falls back to heuristic workers with no orchestrator when JSON is junk', async () => {
    const slices = await planBoardSlices({ ...BASE }, '???')
    expect(slices.length).toBeGreaterThan(0)
    expect(slices.every((slice) => slice.status === 'pending')).toBe(true)
  })

  it('makes review wait on implement in the heuristic plan', async () => {
    const slices = await heuristicBoardSlices({ ...BASE })
    const implementSlices = slices.filter((slice) => slice.kind === 'implement')
    const review = slices.find((slice) => slice.kind === 'review')
    const lastImplement = implementSlices[implementSlices.length - 1]
    expect(lastImplement).toBeTruthy()
    if (review && lastImplement) expect(review.dependsOn).toEqual([lastImplement.id])
  })

  it('keeps a simple implement card on one worker instead of cloning heavy panes', async () => {
    const slices = await planBoardSlices({
      ...BASE,
      prompt: 'implement login',
    })
    const implementSlices = slices.filter((slice) => slice.kind === 'implement')
    expect(implementSlices).toHaveLength(1)
    expect(implementSlices[0]?.dependsOn).toEqual([])
  })

  it('returns a single api slice when the probe routes to api:google', async () => {
    const slices = await planBoardSlices(
      { ...BASE, installedAgents: [], enabledAgents: [] },
      null,
      async () => ({ kind: 'implement', agent: 'api:google', reason: 'x' }),
    )
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({
      agent: 'api:google',
      kind: 'implement',
      status: 'pending',
    })
  })

  it('returns a single CLI slice when the probe accepts an installed agent', async () => {
    const slices = await heuristicBoardSlices(
      { ...BASE },
      async () => ({ kind: 'mechanical', agent: 'codex', reason: 'x' }),
    )
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({
      agent: 'codex',
      kind: 'mechanical',
      status: 'pending',
    })
  })
})

describe('serializeSiblingSlices', () => {
  it('lets implement slices with disjoint files start together', () => {
    const slices = serializeSiblingSlices([
      {
        id: 'a',
        kind: 'implement',
        agent: 'claude',
        prompt: 'a',
        dependsOn: [],
        allowedFiles: ['src/a.ts'],
        status: 'pending',
      },
      {
        id: 'b',
        kind: 'implement',
        agent: 'codex',
        prompt: 'b',
        dependsOn: [],
        allowedFiles: ['src/b.ts'],
        status: 'pending',
      },
    ])
    expect(slices[0]?.dependsOn).toEqual([])
    expect(slices[1]?.dependsOn).toEqual([])
  })

  it('serializes implement slices that share files or the whole repo', () => {
    const slices = serializeSiblingSlices([
      {
        id: 'a',
        kind: 'implement',
        agent: 'claude',
        prompt: 'a',
        dependsOn: [],
        allowedFiles: [],
        status: 'pending',
      },
      {
        id: 'b',
        kind: 'implement',
        agent: 'codex',
        prompt: 'b',
        dependsOn: [],
        allowedFiles: ['src/b.ts'],
        status: 'pending',
      },
    ])
    expect(slices[1]?.dependsOn).toContain('a')
  })
})
