import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';

export type TerminalCommandPreset = 'bash' | 'claude' | 'codex';

export type TerminalNodeData = {
  label: string;
  sessionId: string;
  commandPreset: TerminalCommandPreset;
  command: string;
  args: string[];
};

export type FlashworkNode = Node<TerminalNodeData, 'terminal'>;

type CanvasState = {
  nodes: FlashworkNode[];
  edges: Edge[];
  setNodes: (nodes: FlashworkNode[] | ((nodes: FlashworkNode[]) => FlashworkNode[])) => void;
  setEdges: (edges: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  addTerminalNode: (input: {
    sessionId: string;
    commandPreset: TerminalCommandPreset;
    command: string;
    args: string[];
    position?: { x: number; y: number };
  }) => void;
  upsertTerminalFromSession: (input: {
    sessionId: string;
    command: string;
    args: string[];
  }) => void;
  removeNode: (id: string) => void;
};

function resolvePreset(command: string): TerminalCommandPreset {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (base === 'claude' || base.startsWith('claude')) return 'claude';
  if (base === 'codex' || base.startsWith('codex')) return 'codex';
  return 'bash';
}

let terminalSeq = 0;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  setNodes: (nodes) =>
    set({
      nodes: typeof nodes === 'function' ? nodes(get().nodes) : nodes,
    }),
  setEdges: (edges) =>
    set({
      edges: typeof edges === 'function' ? edges(get().edges) : edges,
    }),
  addTerminalNode: ({ sessionId, commandPreset, command, args, position }) => {
    terminalSeq += 1;
    const id = `terminal-${sessionId}`;
    const node: FlashworkNode = {
      id,
      type: 'terminal',
      position: position ?? {
        x: 80 + (terminalSeq % 5) * 40,
        y: 80 + (terminalSeq % 5) * 40,
      },
      data: {
        label: `${commandPreset} · ${sessionId.slice(0, 8)}`,
        sessionId,
        commandPreset,
        command,
        args,
      },
      style: { width: 520, height: 320 },
    };
    set({ nodes: [...get().nodes.filter((n) => n.id !== id), node] });
  },
  upsertTerminalFromSession: ({ sessionId, command, args }) => {
    const existing = get().nodes.find(
      (node) => node.type === 'terminal' && node.data.sessionId === sessionId,
    );
    if (existing) return;
    get().addTerminalNode({
      sessionId,
      commandPreset: resolvePreset(command),
      command,
      args,
    });
  },
  removeNode: (id) => {
    set({
      nodes: get().nodes.filter((node) => node.id !== id),
      edges: get().edges.filter((edge) => edge.source !== id && edge.target !== id),
    });
  },
}));

export function resolveCommandPreset(preset: TerminalCommandPreset): {
  command: string;
  args: string[];
} {
  switch (preset) {
    case 'claude':
      return { command: 'claude', args: [] };
    case 'codex':
      return { command: 'codex', args: [] };
    case 'bash':
    default:
      return { command: '/bin/bash', args: [] };
  }
}
