import { describe, expect, it } from 'vitest'

import { runFlow } from './runner'
import type { FlowDeps } from './types'

const idleDeps: FlowDeps = {
  runAgent: async () => {
    throw new Error('agent should not run')
  },
  http: async () => {
    throw new Error('http should not run')
  },
  mcp: async () => {
    throw new Error('mcp should not run')
  },
}

describe('runFlow', () => {
  it('pipes agent output into text then filter', async () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'agent' as const, data: { prompt: 'hi' } },
        { id: 't', type: 'text' as const, data: { template: 'OUT: {{input}}' } },
        { id: 'f', type: 'filter' as const, data: { includes: 'OUT:' } },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 't' },
        { id: 'e2', from: 't', to: 'f' },
      ],
    }
    const result = await runFlow(graph, {
      runAgent: async () => 'hello',
      http: async () => {
        throw new Error('http should not run')
      },
      mcp: async () => {
        throw new Error('mcp should not run')
      },
    })
    expect(result.nodeOutputs.f).toBe('OUT: hello')
  })

  it('rejects cycles', async () => {
    await expect(
      runFlow(
        {
          nodes: [
            { id: 'a', type: 'text', data: { template: 'x' } },
            { id: 'b', type: 'text', data: { template: 'y' } },
          ],
          edges: [
            { id: 'e1', from: 'a', to: 'b' },
            { id: 'e2', from: 'b', to: 'a' },
          ],
        },
        idleDeps,
      ),
    ).rejects.toThrow(/cycle/)
  })

  it('interpolates {{input}} only on text nodes', async () => {
    const result = await runFlow(
      {
        nodes: [{ id: 't', type: 'text', data: { template: 'A {{input}} B {{input}}' } }],
        edges: [],
      },
      idleDeps,
    )
    expect(result.nodeOutputs.t).toBe('A  B ')
  })

  it('filters with jsonPath $.a.b split by dots only', async () => {
    const result = await runFlow(
      {
        nodes: [
          { id: 't', type: 'text', data: { template: '{"a":{"b":"ok"}}' } },
          { id: 'f', type: 'filter', data: { jsonPath: '$.a.b' } },
        ],
        edges: [{ id: 'e1', from: 't', to: 'f' }],
      },
      idleDeps,
    )
    expect(result.nodeOutputs.f).toBe('ok')
  })

  it('filters with regex and drops a miss', async () => {
    await expect(
      runFlow(
        {
          nodes: [
            { id: 't', type: 'text', data: { template: 'hello' } },
            { id: 'f', type: 'filter', data: { regex: '^nope' } },
          ],
          edges: [{ id: 'e1', from: 't', to: 'f' }],
        },
        idleDeps,
      ),
    ).rejects.toThrow(/filter/)
  })

  it('runs nodes one at a time in Kahn order', async () => {
    const order: string[] = []
    await runFlow(
      {
        nodes: [
          { id: 'a', type: 'agent', data: {} },
          { id: 'b', type: 'agent', data: {} },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b' }],
      },
      {
        ...idleDeps,
        runAgent: async (node, input) => {
          order.push(`${node.id}:${input}`)
          return node.id
        },
      },
    )
    expect(order).toEqual(['a:', 'b:a'])
  })

  it('dispatches http and mcp nodes through deps', async () => {
    const result = await runFlow(
      {
        nodes: [
          { id: 'h', type: 'http', data: { url: 'https://example.com' } },
          { id: 'm', type: 'mcpTool', data: { serverId: 'demo', toolName: 'ping' } },
        ],
        edges: [{ id: 'e1', from: 'h', to: 'm' }],
      },
      {
        ...idleDeps,
        http: async () => 'from-http',
        mcp: async (_node, input) => `mcp:${input}`,
      },
    )
    expect(result.nodeOutputs.m).toBe('mcp:from-http')
  })
})
