import type { FlowDeps, FlowRunGraph, FlowRunNode, FlowRunResult } from './types'

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function interpolateText(template: string, input: string): string {
  return template.split('{{input}}').join(input)
}

function jsonPathValue(input: string, path: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('filter jsonPath: input is not JSON')
  }
  const parts = path.split('.').filter((part) => part.length > 0 && part !== '$')
  let current: unknown = parsed
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error('filter jsonPath: path not found')
    }
    current = (current as Record<string, unknown>)[part]
  }
  if (current === undefined) throw new Error('filter jsonPath: path not found')
  return typeof current === 'string' ? current : JSON.stringify(current)
}

function applyFilter(node: FlowRunNode, input: string): string {
  const jsonPath = asString(node.data.jsonPath)
  if (jsonPath) return jsonPathValue(input, jsonPath)

  const regexSource = asString(node.data.regex)
  if (regexSource) {
    let regex: RegExp
    try {
      regex = new RegExp(regexSource)
    } catch {
      throw new Error('filter regex: invalid pattern')
    }
    if (!regex.test(input)) throw new Error('filter: no match')
    return input
  }

  const includes = asString(node.data.includes)
  if (includes && !input.includes(includes)) throw new Error('filter: no match')
  return input
}

function topologicalOrder(graph: FlowRunGraph): FlowRunNode[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  if (nodes.size !== graph.nodes.length) throw new Error('duplicate node id')
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const node of graph.nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
    indegree.set(node.id, 0)
  }
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new Error('edge references a missing node')
    }
    incoming.get(edge.to)!.push(edge.from)
    outgoing.get(edge.from)!.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const order: FlowRunNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodes.get(id)
    if (!node) continue
    order.push(node)
    for (const next of outgoing.get(id) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, nextDegree)
      if (nextDegree === 0) queue.push(next)
    }
  }
  if (order.length !== graph.nodes.length) throw new Error('cycle')
  return order
}

async function executeNode(
  node: FlowRunNode,
  input: string,
  deps: FlowDeps,
): Promise<string> {
  switch (node.type) {
    case 'text':
      return interpolateText(asString(node.data.template), input)
    case 'filter':
      return applyFilter(node, input)
    case 'agent':
      return deps.runAgent(node, input)
    case 'http':
      return deps.http(node, input)
    case 'mcpTool':
      return deps.mcp(node, input)
    default:
      throw new Error(`unknown node type: ${String(node.type)}`)
  }
}

export async function runFlow(graph: FlowRunGraph, deps: FlowDeps): Promise<FlowRunResult> {
  const incoming = new Map<string, string[]>()
  for (const node of graph.nodes) incoming.set(node.id, [])
  for (const edge of graph.edges) {
    incoming.get(edge.to)?.push(edge.from)
  }
  const order = topologicalOrder(graph)
  const nodeOutputs: Record<string, string> = {}
  for (const node of order) {
    const parents = incoming.get(node.id) ?? []
    const input = parents.map((id) => nodeOutputs[id] ?? '').join('\n')
    nodeOutputs[node.id] = await executeNode(node, input, deps)
  }
  return { nodeOutputs }
}
