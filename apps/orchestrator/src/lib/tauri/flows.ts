import { invoke } from '@tauri-apps/api/core'

import type { FlowGraph } from '../flows/types'

export function saveFlowGraph(folder: string, graph: FlowGraph): Promise<void> {
  return invoke('save_flow_graph', { folder, graph })
}

export function listFlowGraphs(folder: string): Promise<FlowGraph[]> {
  return invoke('list_flow_graphs', { folder })
}

export function deleteFlowGraph(folder: string, graphId: string): Promise<void> {
  return invoke('delete_flow_graph', { folder, graphId })
}

export function flowHttp(args: {
  folder: string
  url: string
  method: string
  body?: string | null
  confirmedHosts: string[]
  allowLoopback: boolean
}): Promise<string> {
  return invoke('flow_http', args)
}

export function flowHttpAllowlist(folder: string): Promise<string[]> {
  return invoke('flow_http_allowlist', { folder })
}

export function flowHttpAllowlistSet(folder: string, hosts: string[]): Promise<void> {
  return invoke('flow_http_allowlist_set', { folder, hosts })
}

export function flowMcpCall(args: {
  folder: string
  serverId: string
  toolName: string
  arguments?: Record<string, unknown> | null
}): Promise<string> {
  return invoke('flow_mcp_call', args)
}
