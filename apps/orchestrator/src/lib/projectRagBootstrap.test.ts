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
  it('skips Graphify and AI Memory when those features are off', async () => {
    const graphifyEnsureGraph = vi.fn()
    const aiMemoryMcpConfigPath = vi.fn()
    const writeRagStatus = vi.fn()

    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnabled: false,
      aiMemoryEnabled: false,
      graphifyEnsureGraph,
      aiMemoryMcpConfigPath,
      writeRagStatus,
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(graphifyEnsureGraph).not.toHaveBeenCalled()
    expect(aiMemoryMcpConfigPath).not.toHaveBeenCalled()
    expect(status).toEqual({
      graphify: 'unavailable',
      aiMemory: false,
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
    expect(writeRagStatus).toHaveBeenCalledWith('/workspace/example', status)
  })

  it('treats Graphify errors as unavailable and still writes STATUS.json', async () => {
    const writeRagStatus = vi.fn()

    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnabled: true,
      aiMemoryEnabled: true,
      graphifyEnsureGraph: async () => {
        throw new Error('graphify missing')
      },
      aiMemoryMcpConfigPath: async () => '/workspace/example/.claude/mcp.json',
      writeRagStatus,
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(status).toEqual({
      graphify: 'unavailable',
      aiMemory: true,
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
    expect(writeRagStatus).toHaveBeenCalledWith('/workspace/example', status)
  })

  it('records AI Memory only when the MCP config write succeeds', async () => {
    const writeRagStatus = vi.fn()

    const status = await bootstrapProjectRag('/workspace/example', {
      graphifyEnabled: true,
      aiMemoryEnabled: true,
      graphifyEnsureGraph: async () => 'started',
      aiMemoryMcpConfigPath: async () => {
        throw new Error('mcp write failed')
      },
      writeRagStatus,
      now: () => '2026-09-19T05:00:00.000Z',
    })

    expect(status).toEqual({
      graphify: 'exists',
      aiMemory: false,
      updatedAt: '2026-09-19T05:00:00.000Z',
    })
  })

  it('does not throw when writing STATUS.json fails', async () => {
    await expect(
      bootstrapProjectRag('/workspace/example', {
        graphifyEnabled: false,
        aiMemoryEnabled: false,
        graphifyEnsureGraph: vi.fn(),
        aiMemoryMcpConfigPath: vi.fn(),
        writeRagStatus: async () => {
          throw new Error('disk full')
        },
      }),
    ).resolves.toEqual({
      graphify: 'unavailable',
      aiMemory: false,
      updatedAt: expect.any(String),
    })
  })
})
