import { useCallback, useEffect, useState, type DragEvent } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { TerminalNode } from './nodes/TerminalNode';
import {
  resolveCommandPreset,
  useCanvasStore,
  type FlashworkNode,
  type TerminalCommandPreset,
} from '../state/canvasStore';

const nodeTypes = {
  terminal: TerminalNode,
} as NodeTypes;

const DND_MIME = 'application/flashwork-terminal-preset';

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `pty-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type SpawnTerminalFn = (
  preset: TerminalCommandPreset,
  position?: { x: number; y: number },
) => Promise<void>;

function CanvasToolbar({
  preset,
  setPreset,
  busy,
  error,
  onAdd,
}: {
  preset: TerminalCommandPreset;
  setPreset: (preset: TerminalCommandPreset) => void;
  busy: boolean;
  error: string | null;
  onAdd: () => void;
}) {
  return (
    <div className="canvas-toolbar">
      <div className="brand">Flashwork</div>
      <label className="toolbar-field">
        <span>Comando</span>
        <select
          value={preset}
          onChange={(event) => setPreset(event.target.value as TerminalCommandPreset)}
        >
          <option value="bash">bash</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </label>
      <div
        className="palette-item"
        draggable={!busy}
        onDragStart={(event) => {
          event.dataTransfer.setData(DND_MIME, preset);
          event.dataTransfer.effectAllowed = 'move';
        }}
        title="Arraste para o canvas"
      >
        Terminal ({preset})
      </div>
      <button type="button" disabled={busy} onClick={onAdd}>
        {busy ? 'Criando…' : 'Adicionar Terminal'}
      </button>
      {error ? <p className="toolbar-error">{error}</p> : null}
    </div>
  );
}

function CanvasBoard() {
  const [preset, setPreset] = useState<TerminalCommandPreset>('bash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const addTerminalNode = useCanvasStore((s) => s.addTerminalNode);
  const upsertTerminalFromSession = useCanvasStore((s) => s.upsertTerminalFromSession);
  const { screenToFlowPosition } = useReactFlow();

  const spawnTerminal = useCallback<SpawnTerminalFn>(
    async (commandPreset, position) => {
      const api = window.flashwork;
      if (!api) {
        setError('Preload IPC indisponível');
        return;
      }

      setBusy(true);
      setError(null);
      const sessionId = createSessionId();
      const resolved = resolveCommandPreset(commandPreset);
      const flowPosition =
        position ??
        screenToFlowPosition({
          x: window.innerWidth / 2 - 160,
          y: window.innerHeight / 2 - 120,
        });

      try {
        await api.pty.send({
          type: 'spawn',
          sessionId,
          command: resolved.command,
          args: resolved.args,
          cols: 80,
          rows: 24,
        });
        addTerminalNode({
          sessionId,
          commandPreset,
          command: resolved.command,
          args: resolved.args,
          position: flowPosition,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          commandPreset === 'bash'
            ? message
            : `${message} — tente bash se ${commandPreset} não estiver no PATH`,
        );
      } finally {
        setBusy(false);
      }
    },
    [addTerminalNode, screenToFlowPosition],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlashworkNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((current) => applyEdgeChanges(changes, current));
    },
    [setEdges],
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const dropped = event.dataTransfer.getData(DND_MIME) as TerminalCommandPreset;
      if (!dropped) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      void spawnTerminal(dropped, position);
    },
    [screenToFlowPosition, spawnTerminal],
  );

  useEffect(() => {
    const api = window.flashwork;
    if (!api) return;
    void api.pty.list().then((sessions) => {
      for (const session of sessions) {
        upsertTerminalFromSession({
          sessionId: session.sessionId,
          command: session.command,
          args: session.args,
        });
      }
    });
  }, [upsertTerminalFromSession]);

  return (
    <div className="canvas-shell">
      <CanvasToolbar
        preset={preset}
        setPreset={setPreset}
        busy={busy}
        error={error}
        onAdd={() => void spawnTerminal(preset)}
      />
      <div className="canvas-stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onDragOver={onDragOver}
          onDrop={onDrop}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="#cbd5e1" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

export function CanvasRoot() {
  return (
    <ReactFlowProvider>
      <CanvasBoard />
    </ReactFlowProvider>
  );
}
