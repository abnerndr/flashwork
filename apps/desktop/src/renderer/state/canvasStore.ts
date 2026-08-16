import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';
import type { TerminalCommandPreset } from '@flashwork/shared-types';

export type { TerminalCommandPreset };

export type TerminalNodeData = {
  label: string;
  sessionId: string;
  commandPreset: TerminalCommandPreset;
  command: string;
  args: string[];
  floorId: string | null;
  worktreePath?: string;
};

export type FloorContainerNodeData = {
  label: string;
  floorId: string;
  name: string;
  branch: string;
  worktreePath: string;
};

export type FlashworkNode =
  | Node<TerminalNodeData, 'terminal'>
  | Node<FloorContainerNodeData, 'floorContainer'>;

type CanvasState = {
  nodes: FlashworkNode[];
  edges: Edge[];
  setNodes: (nodes: FlashworkNode[] | ((nodes: FlashworkNode[]) => FlashworkNode[])) => void;
  setEdges: (edges: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  addFloorContainer: (input: {
    floorId: string;
    name: string;
    branch: string;
    worktreePath: string;
    position?: { x: number; y: number };
  }) => void;
  addTerminalNode: (input: {
    sessionId: string;
    commandPreset: TerminalCommandPreset;
    command: string;
    args: string[];
    floorId?: string | null;
    worktreePath?: string;
    position?: { x: number; y: number };
  }) => void;
  upsertTerminalFromSession: (input: {
    sessionId: string;
    command: string;
    args: string[];
    cwd?: string;
  }) => void;
  removeNode: (id: string) => FlashworkNode | undefined;
  takeRemovedTerminalSessions: (before: FlashworkNode[], after: FlashworkNode[]) => string[];
};

function resolvePreset(command: string): TerminalCommandPreset {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (base === 'claude' || base.startsWith('claude')) return 'claude';
  if (base === 'codex' || base.startsWith('codex')) return 'codex';
  return 'bash';
}

function killPtySession(sessionId: string): void {
  void window.flashwork?.pty.send({ type: 'kill', sessionId });
}

let terminalSeq = 0;
let floorSeq = 0;

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
  addFloorContainer: ({ floorId, name, branch, worktreePath, position }) => {
    floorSeq += 1;
    const id = `floor-${floorId}`;
    const node: FlashworkNode = {
      id,
      type: 'floorContainer',
      position: position ?? {
        x: 40 + ((floorSeq - 1) % 3) * 580,
        y: 40 + Math.floor((floorSeq - 1) / 3) * 420,
      },
      data: {
        label: name,
        floorId,
        name,
        branch,
        worktreePath,
      },
      style: { width: 560, height: 380 },
    };
    set({ nodes: [...get().nodes.filter((n) => n.id !== id), node] });
  },
  addTerminalNode: ({
    sessionId,
    commandPreset,
    command,
    args,
    floorId = null,
    worktreePath,
    position,
  }) => {
    terminalSeq += 1;
    const id = `terminal-${sessionId}`;
    const parentId = floorId ? `floor-${floorId}` : undefined;
    const node: FlashworkNode = {
      id,
      type: 'terminal',
      position: position ?? {
        x: parentId ? 20 + (terminalSeq % 3) * 24 : 80 + (terminalSeq % 5) * 40,
        y: parentId ? 56 + (terminalSeq % 3) * 24 : 80 + (terminalSeq % 5) * 40,
      },
      parentId,
      extent: parentId ? 'parent' : undefined,
      data: {
        label: `${commandPreset} · ${sessionId.slice(0, 8)}`,
        sessionId,
        commandPreset,
        command,
        args,
        floorId,
        worktreePath,
      },
      style: { width: 480, height: 280 },
    };
    set({ nodes: [...get().nodes.filter((n) => n.id !== id), node] });
  },
  upsertTerminalFromSession: ({ sessionId, command, args, cwd }) => {
    const existing = get().nodes.find(
      (node) => node.type === 'terminal' && node.data.sessionId === sessionId,
    );
    if (existing) return;
    get().addTerminalNode({
      sessionId,
      commandPreset: resolvePreset(command),
      command,
      args,
      worktreePath: cwd,
    });
  },
  removeNode: (id) => {
    const node = get().nodes.find((item) => item.id === id);
    if (node?.type === 'terminal') {
      killPtySession(node.data.sessionId);
    }
    set({
      nodes: get().nodes.filter((item) => item.id !== id),
      edges: get().edges.filter((edge) => edge.source !== id && edge.target !== id),
    });
    return node;
  },
  takeRemovedTerminalSessions: (before, after) => {
    const afterIds = new Set(after.map((node) => node.id));
    const sessions: string[] = [];
    for (const node of before) {
      if (afterIds.has(node.id)) continue;
      if (node.type === 'terminal') {
        sessions.push(node.data.sessionId);
      }
    }
    return sessions;
  },
}));
