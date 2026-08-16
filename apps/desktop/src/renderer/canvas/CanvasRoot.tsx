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
import type { TerminalCommandPreset } from '@flashwork/shared-types';

import { FloorContainer } from './nodes/FloorContainer';
import { TerminalNode } from './nodes/TerminalNode';
import { useCanvasStore, type FlashworkNode } from '../state/canvasStore';
import { useFloorsStore } from '../state/floorsStore';

const nodeTypes = {
  terminal: TerminalNode,
  floorContainer: FloorContainer,
} as NodeTypes;

const DND_MIME = 'application/flashwork-terminal-preset';

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `pty-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function killPtySessions(sessionIds: string[]): void {
  const api = window.flashwork;
  if (!api) return;
  for (const sessionId of sessionIds) {
    void api.pty.send({ type: 'kill', sessionId });
  }
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
  activeFloorId,
  floors,
  onSelectFloor,
  onAddFloor,
  onAddTerminal,
}: {
  preset: TerminalCommandPreset;
  setPreset: (preset: TerminalCommandPreset) => void;
  busy: boolean;
  error: string | null;
  activeFloorId: string | null;
  floors: { id: string; name: string }[];
  onSelectFloor: (floorId: string | null) => void;
  onAddFloor: () => void;
  onAddTerminal: () => void;
}) {
  return (
    <div className="canvas-toolbar">
      <div className="brand">Flashwork</div>
      <label className="toolbar-field">
        <span>Floor</span>
        <select
          value={activeFloorId ?? ''}
          onChange={(event) => onSelectFloor(event.target.value || null)}
        >
          <option value="">(sem floor)</option>
          {floors.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={onAddFloor}>
        {busy ? 'Criando…' : 'Novo Floor'}
      </button>
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
      <button type="button" disabled={busy} onClick={onAddTerminal}>
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
  const addFloorContainer = useCanvasStore((s) => s.addFloorContainer);
  const upsertTerminalFromSession = useCanvasStore((s) => s.upsertTerminalFromSession);
  const takeRemovedTerminalSessions = useCanvasStore((s) => s.takeRemovedTerminalSessions);
  const floors = useFloorsStore((s) => s.floors);
  const activeFloorId = useFloorsStore((s) => s.activeFloorId);
  const upsertFloor = useFloorsStore((s) => s.upsertFloor);
  const setFloors = useFloorsStore((s) => s.setFloors);
  const setActiveFloorId = useFloorsStore((s) => s.setActiveFloorId);
  const getFloor = useFloorsStore((s) => s.getFloor);
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
      const floor = activeFloorId ? getFloor(activeFloorId) : undefined;
      const flowPosition =
        position ??
        (floor
          ? { x: 24, y: 64 }
          : screenToFlowPosition({
              x: window.innerWidth / 2 - 160,
              y: window.innerHeight / 2 - 120,
            }));

      try {
        await api.pty.send({
          type: 'spawn',
          sessionId,
          preset: commandPreset,
          cwd: floor?.worktreePath,
          cols: 80,
          rows: 24,
        });
        addTerminalNode({
          sessionId,
          commandPreset,
          command: commandPreset,
          args: [],
          floorId: floor?.id ?? null,
          worktreePath: floor?.worktreePath,
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
    [activeFloorId, addTerminalNode, getFloor, screenToFlowPosition],
  );

  const createFloor = useCallback(async () => {
    const api = window.flashwork;
    if (!api) {
      setError('Preload IPC indisponível');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const floor = await api.floors.create({
        name: `Floor ${floors.length + 1}`,
      });
      upsertFloor(floor);
      setActiveFloorId(floor.id);
      addFloorContainer({
        floorId: floor.id,
        name: floor.name,
        branch: floor.branch,
        worktreePath: floor.worktreePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [addFloorContainer, floors.length, setActiveFloorId, upsertFloor]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlashworkNode>[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        const removedSessions = takeRemovedTerminalSessions(current, next);
        if (removedSessions.length > 0) {
          killPtySessions(removedSessions);
        }
        return next;
      });
    },
    [setNodes, takeRemovedTerminalSessions],
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
    void api.floors.list().then((listed) => {
      setFloors(listed);
      for (const floor of listed) {
        addFloorContainer({
          floorId: floor.id,
          name: floor.name,
          branch: floor.branch,
          worktreePath: floor.worktreePath,
        });
      }
    });
    void api.pty.list().then((sessions) => {
      for (const session of sessions) {
        upsertTerminalFromSession({
          sessionId: session.sessionId,
          command: session.command,
          args: session.args,
          cwd: session.cwd,
        });
      }
    });
  }, [addFloorContainer, setFloors, upsertTerminalFromSession]);

  return (
    <div className="canvas-shell">
      <CanvasToolbar
        preset={preset}
        setPreset={setPreset}
        busy={busy}
        error={error}
        activeFloorId={activeFloorId}
        floors={floors}
        onSelectFloor={setActiveFloorId}
        onAddFloor={() => void createFloor()}
        onAddTerminal={() => void spawnTerminal(preset)}
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
