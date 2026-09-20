import { flowHttp, flowMcpCall } from '../tauri/flows'
import { assertFlowHttpUrl, defaultHttpBody } from './httpUrl'
import { runFlow } from './runner'
import { runFlowAgent, type FlowAgentContext } from './executeAgent'
import type { FlowDeps, FlowGraph, FlowRunResult } from './types'

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export type RunLiveFlowInput = {
  graph: FlowGraph
  folder: string
  allowLoopback: boolean
  confirmedHosts: string[]
  allowlistHosts: string[]
  agent: FlowAgentContext
}

export async function runLiveFlow(input: RunLiveFlowInput): Promise<FlowRunResult> {
  const deps: FlowDeps = {
    runAgent: (node, text) => runFlowAgent(node, text, input.agent),
    http: async (node, text) => {
      const url = asString(node.data.url)
      const method = asString(node.data.method, 'POST')
      assertFlowHttpUrl(url, {
        allowLoopback: input.allowLoopback,
        allowlistHosts: input.allowlistHosts,
        confirmedHosts: input.confirmedHosts,
      })
      return flowHttp({
        folder: input.folder,
        url,
        method,
        body: defaultHttpBody(node.data.body, text),
        confirmedHosts: input.confirmedHosts,
        allowLoopback: input.allowLoopback,
      })
    },
    mcp: async (node, text) => {
      const serverId = asString(node.data.serverId)
      const toolName = asString(node.data.toolName)
      let parsed: Record<string, unknown> = { text }
      const rawArgs = node.data.arguments
      if (typeof rawArgs === 'string' && rawArgs.trim()) {
        parsed = JSON.parse(rawArgs) as Record<string, unknown>
      } else if (rawArgs && typeof rawArgs === 'object') {
        parsed = rawArgs as Record<string, unknown>
      }
      return flowMcpCall({
        folder: input.folder,
        serverId,
        toolName,
        arguments: parsed,
      })
    },
  }
  return runFlow(input.graph, deps)
}
