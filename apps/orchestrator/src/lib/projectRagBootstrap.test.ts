import { describe, expect, it, vi } from 'vitest'

import { bootstrapProjectRag, mapGraphifyBootstrapStatus } from './projectRagBootstrap'

describe('mapGraphifyBootstrapStatus', () => {
  it.each(['exists', 'generating', 'started'] as const)(
    'maps %s to an existing graph',
    (status) => {
      expect(mapGraphifyBootstrapStatus(status)).toBe('exists')
    },
  )

  it.each(['unavailable', undefined] as const)(
    'maps %s to an unavailable graph',
    (status) => {
      expect(mapGraphifyBootstrapStatus(status)).toBe('unavailable')
    },
  )
})

describe('bootstrapProjectRag', () => {
  it('always starts Graphify and offers the install when it is missing', async () => {
    const graphifyEnsureGraph = vi.fn(async () => 'unavailable' as const)
    const onGraphifyUnavailable = vi.fn()
    const writeRagStatus = vi.fn()

    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnsureGraph,
      onGraphifyUnavailable,
      writeRagStatus,
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(graphifyEnsureGraph).toHaveBeenCalledWith('/workspace/example')
    expect(onGraphifyUnavailable).toHaveBeenCalledWith('/workspace/example')
    expect(status).toEqual({
      graphify: 'unavailable',
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
    expect(writeRagStatus).toHaveBeenCalledWith('/workspace/example', status)
  })

  it('treats Graphify errors as unavailable and still writes STATUS.json', async () => {
    const writeRagStatus = vi.fn()

    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnsureGraph: async () => {
        throw new Error('graphify missing')
      },
      writeRagStatus,
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(status).toEqual({
      graphify: 'unavailable',
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
    expect(writeRagStatus).toHaveBeenCalledWith('/workspace/example', status)
  })

  it('records an existing graph when Graphify starts', async () => {
    const onGraphifyUnavailable = vi.fn()
    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnsureGraph: async () => 'started',
      onGraphifyUnavailable,
      writeRagStatus: vi.fn(),
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(status).toEqual({
      graphify: 'exists',
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
    expect(onGraphifyUnavailable).not.toHaveBeenCalled()
  })

  it('does not throw when writing STATUS.json fails', async () => {
    await expect(
      bootstrapProjectRag('/workspace/example', {
        graphifyEnsureGraph: async () => 'unavailable',
        writeRagStatus: async () => {
          throw new Error('disk full')
        },
      }),
    ).resolves.toEqual({
      graphify: 'unavailable',
      updatedAt: expect.any(String),
    })
  })
})
