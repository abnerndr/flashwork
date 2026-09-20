import { nanoid } from 'nanoid'
import { create } from 'zustand'

import { deleteFlowGraph, listFlowGraphs, saveFlowGraph } from '../lib/tauri/flows'
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeType } from '../lib/flows/types'

const persistTimers = new Map<string, number>()

function persist(folder: string | null, graph: FlowGraph): void {
  if (!folder) return
  const write = () => {
    persistTimers.delete(graph.id)
    void saveFlowGraph(folder, graph).catch((cause) => {
      console.warn('[flows] persist failed:', cause)
    })
  }
  if (typeof window === 'undefined') {
    write()
    return
  }
  const previous = persistTimers.get(graph.id)
  if (previous != null) window.clearTimeout(previous)
  persistTimers.set(graph.id, window.setTimeout(write, 250))
}

function emptyGraph(projectId: string, name: string): FlowGraph {
  return {
    id: nanoid(),
    projectId,
    name,
    nodes: [],
    edges: [],
  }
}

export function defaultNodeData(type: FlowNodeType): Record<string, unknown> {
  switch (type) {
    case 'agent':
      return { prompt: '' }
    case 'text':
      return { template: '{{input}}' }
    case 'filter':
      return { includes: '' }
    case 'http':
      return { url: '', method: 'POST' }
    case 'mcpTool':
      return { serverId: '', toolName: '' }
    default:
      return {}
  }
}

type FlowsState = {
  graphs: FlowGraph[]
  activeGraphId: string | null
  nodeOutputs: Record<string, string>
  running: boolean
  error: string | null
  selectedNodeId: string | null
  pendingFrom: string | null
  hydrate: (folder: string, projectId: string) => Promise<void>
  setActiveGraph: (graphId: string) => void
  createGraph: (folder: string, projectId: string) => void
  addNode: (folder: string | null, type: FlowNodeType, x: number, y: number) => void
  moveNode: (folder: string | null, nodeId: string, x: number, y: number) => void
  patchNodeData: (folder: string | null, nodeId: string, data: Record<string, unknown>) => void
  removeNode: (folder: string | null, nodeId: string) => void
  addEdge: (folder: string | null, from: string, to: string) => void
  removeEdge: (folder: string | null, edgeId: string) => void
  setSelectedNode: (nodeId: string | null) => void
  setPendingFrom: (nodeId: string | null) => void
  setRunResult: (outputs: Record<string, string>, error: string | null) => void
  setRunning: (running: boolean) => void
  deleteActive: (folder: string | null) => void
}

function activeGraph(state: FlowsState): FlowGraph | null {
  return state.graphs.find((graph) => graph.id === state.activeGraphId) ?? state.graphs[0] ?? null
}

function replaceActive(
  state: FlowsState,
  folder: string | null,
  next: FlowGraph,
): Pick<FlowsState, 'graphs' | 'activeGraphId'> {
  persist(folder, next)
  const graphs = state.graphs.some((graph) => graph.id === next.id)
    ? state.graphs.map((graph) => (graph.id === next.id ? next : graph))
    : [next, ...state.graphs]
  return { graphs, activeGraphId: next.id }
}

export const useFlowsStore = create<FlowsState>((set, get) => ({
  graphs: [],
  activeGraphId: null,
  nodeOutputs: {},
  running: false,
  error: null,
  selectedNodeId: null,
  pendingFrom: null,
  hydrate: async (folder, projectId) => {
    try {
      const listed = await listFlowGraphs(folder)
      const graphs = listed.length > 0 ? listed : [emptyGraph(projectId, 'Flow 1')]
      if (listed.length === 0 && folder) persist(folder, graphs[0]!)
      set({
        graphs,
        activeGraphId: graphs[0]?.id ?? null,
        nodeOutputs: {},
        error: null,
        selectedNodeId: null,
        pendingFrom: null,
      })
    } catch (cause) {
      console.warn('[flows] hydrate failed:', cause)
      const graph = emptyGraph(projectId, 'Flow 1')
      set({ graphs: [graph], activeGraphId: graph.id })
    }
  },
  setActiveGraph: (graphId) => set({ activeGraphId: graphId, selectedNodeId: null, pendingFrom: null }),
  createGraph: (folder, projectId) => {
    const graph = emptyGraph(projectId, `Flow ${get().graphs.length + 1}`)
    set((state) => ({
      graphs: [graph, ...state.graphs],
      activeGraphId: graph.id,
      nodeOutputs: {},
      selectedNodeId: null,
    }))
    persist(folder, graph)
  },
  addNode: (folder, type, x, y) => {
    const current = activeGraph(get())
    if (!current) return
    const node: FlowNode = {
      id: nanoid(),
      type,
      x,
      y,
      data: defaultNodeData(type),
    }
    set((state) =>
      replaceActive(state, folder, { ...current, nodes: [...current.nodes, node] }),
    )
  },
  moveNode: (folder, nodeId, x, y) => {
    const current = activeGraph(get())
    if (!current) return
    set((state) =>
      replaceActive(state, folder, {
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, x, y } : node)),
      }),
    )
  },
  patchNodeData: (folder, nodeId, data) => {
    const current = activeGraph(get())
    if (!current) return
    set((state) =>
      replaceActive(state, folder, {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
        ),
      }),
    )
  },
  removeNode: (folder, nodeId) => {
    const current = activeGraph(get())
    if (!current) return
    set((state) =>
      replaceActive(state, folder, {
        ...current,
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
      }),
    )
    set({
      selectedNodeId: get().selectedNodeId === nodeId ? null : get().selectedNodeId,
      pendingFrom: get().pendingFrom === nodeId ? null : get().pendingFrom,
    })
  },
  addEdge: (folder, from, to) => {
    const current = activeGraph(get())
    if (!current || from === to) return
    if (current.edges.some((edge) => edge.from === from && edge.to === to)) return
    const edge: FlowEdge = { id: nanoid(), from, to }
    set((state) => replaceActive(state, folder, { ...current, edges: [...current.edges, edge] }))
  },
  removeEdge: (folder, edgeId) => {
    const current = activeGraph(get())
    if (!current) return
    set((state) =>
      replaceActive(state, folder, {
        ...current,
        edges: current.edges.filter((edge) => edge.id !== edgeId),
      }),
    )
  },
  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setPendingFrom: (nodeId) => set({ pendingFrom: nodeId }),
  setRunResult: (outputs, error) => set({ nodeOutputs: outputs, error, running: false }),
  setRunning: (running) => set({ running, error: running ? null : get().error }),
  deleteActive: (folder) => {
    const current = activeGraph(get())
    if (!current) return
    if (folder) void deleteFlowGraph(folder, current.id).catch(() => undefined)
    set((state) => {
      const graphs = state.graphs.filter((graph) => graph.id !== current.id)
      return {
        graphs,
        activeGraphId: graphs[0]?.id ?? null,
        selectedNodeId: null,
        nodeOutputs: {},
      }
    })
  },
}))
