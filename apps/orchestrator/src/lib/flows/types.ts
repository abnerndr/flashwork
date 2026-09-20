import type { TaskAttachment, TaskToolSelection } from '../types'

export type FlowNodeType = 'agent' | 'text' | 'filter' | 'http' | 'mcpTool'

export type FlowNode = {
  id: string
  type: FlowNodeType
  x: number
  y: number
  data: Record<string, unknown>
}

export type FlowEdge = {
  id: string
  from: string
  to: string
}

export type FlowGraph = {
  id: string
  projectId: string
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export type FlowAgentNodeData = {
  prompt: string
  attachments?: TaskAttachment[]
  toolSelection?: TaskToolSelection
}

export type FlowRunNode = Pick<FlowNode, 'id' | 'type' | 'data'>

export type FlowRunGraph = {
  nodes: FlowRunNode[]
  edges: FlowEdge[]
}

export type FlowDeps = {
  runAgent: (node: FlowRunNode, input: string) => Promise<string>
  http: (node: FlowRunNode, input: string) => Promise<string>
  mcp: (node: FlowRunNode, input: string) => Promise<string>
}

export type FlowRunResult = {
  nodeOutputs: Record<string, string>
}
