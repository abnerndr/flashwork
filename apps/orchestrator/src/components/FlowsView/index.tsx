import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { Bot, Filter, Globe, Plug, Type } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'

import { runLiveFlow } from '../../lib/flows/execute'
import { flowHttpHosts } from '../../lib/flows/httpUrl'
import type { FlowNode, FlowNodeType } from '../../lib/flows/types'
import { type MessageKey, useT } from '../../lib/i18n'
import { groupServersByName } from '../../lib/mcp'
import { flowHttpAllowlist, mcpScan } from '../../lib/tauri'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import type { TaskToolSelection } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useFlowsStore } from '../../stores/flowsStore'
import { TaskToolPicker } from '../TaskBoardView/TaskToolPicker'
import { UiIcon } from '../ui/UiIcon'
import styles from './FlowsView.module.css'
import { useCanvasZoom } from './hooks/useCanvasZoom'

const NODE_W = 200
const NODE_H = 112
const PALETTE: { type: FlowNodeType; labelKey: MessageKey; icon: typeof Bot }[] = [
  { type: 'agent', labelKey: 'flows.node.agent', icon: Bot },
  { type: 'text', labelKey: 'flows.node.text', icon: Type },
  { type: 'filter', labelKey: 'flows.node.filter', icon: Filter },
  { type: 'http', labelKey: 'flows.node.http', icon: Globe },
  { type: 'mcpTool', labelKey: 'flows.node.mcp', icon: Plug },
]

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function PaletteItem({ type, label }: { type: FlowNodeType; label: string }) {
  const meta = PALETTE.find((item) => item.type === type)!
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `palette:${type}` })
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={styles.paletteItem}
      {...listeners}
      {...attributes}
    >
      <UiIcon icon={meta.icon} />
      <span>{label}</span>
    </button>
  )
}

function portCenter(node: FlowNode, which: 'in' | 'out') {
  return {
    x: which === 'in' ? node.x : node.x + NODE_W,
    y: node.y + NODE_H / 2,
  }
}

export function FlowsView() {
  const t = useT()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const project = useProjectsStore(selectActiveProject)
  const folder = project ? getProjectDefaultCwd(project, useProjectsStore.getState().projects) : ''
  const allowLoopback = useProjectsStore((s) => s.preferences.flowsAllowLoopback)
  const graphs = useFlowsStore((s) => s.graphs)
  const activeGraphId = useFlowsStore((s) => s.activeGraphId)
  const graph = graphs.find((item) => item.id === activeGraphId) ?? graphs[0] ?? null
  const nodeOutputs = useFlowsStore((s) => s.nodeOutputs)
  const running = useFlowsStore((s) => s.running)
  const error = useFlowsStore((s) => s.error)
  const selectedNodeId = useFlowsStore((s) => s.selectedNodeId)
  const pendingFrom = useFlowsStore((s) => s.pendingFrom)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const zoom = useCanvasZoom(containerRef, stageRef)
  const { setNodeRef: setCanvasDropRef } = useDroppable({ id: 'flow-canvas' })
  const [serverNames, setServerNames] = useState<string[]>([])
  const selected = graph?.nodes.find((node) => node.id === selectedNodeId) ?? null

  useEffect(() => {
    if (!folder || !project) return
    void useFlowsStore.getState().hydrate(folder, project.id)
  }, [folder, project?.id])

  useEffect(() => {
    let active = true
    Promise.all([mcpScan('global'), folder ? mcpScan('project', folder) : Promise.resolve([])])
      .then(([global, projectScope]) => {
        if (!active) return
        setServerNames(groupServersByName([...global, ...projectScope]).map((group) => group.name))
      })
      .catch(() => {
        if (active) setServerNames([])
      })
    return () => {
      active = false
    }
  }, [folder])

  const onDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id)
    if (!id.startsWith('palette:') || !containerRef.current || !folder) return
    const type = id.slice('palette:'.length) as FlowNodeType
    const rect = containerRef.current.getBoundingClientRect()
    const translated = event.delta
    const x = (event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientX : rect.left) - rect.left
    const dropX = (x + translated.x - zoom.pan.x) / zoom.zoom - NODE_W / 2
    const dropY =
      ((event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : rect.top) -
        rect.top +
        translated.y -
        zoom.pan.y) /
        zoom.zoom -
      20
    useFlowsStore.getState().addNode(folder, type, Math.round(dropX), Math.round(dropY))
  }

  const startNodeDrag = (node: FlowNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const origin = { x: event.clientX, y: event.clientY, nx: node.x, ny: node.y }
    const move = (ev: PointerEvent) => {
      useFlowsStore.getState().moveNode(folder, node.id, origin.nx + (ev.clientX - origin.x) / zoom.zoom, origin.ny + (ev.clientY - origin.y) / zoom.zoom)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const clickPort = (nodeId: string, which: 'in' | 'out') => {
    const store = useFlowsStore.getState()
    if (which === 'out') {
      store.setPendingFrom(nodeId)
      return
    }
    if (store.pendingFrom) {
      store.addEdge(folder, store.pendingFrom, nodeId)
      store.setPendingFrom(null)
    }
  }

  const run = async () => {
    if (!graph || !project || !folder) return
    const urls = graph.nodes
      .filter((node) => node.type === 'http')
      .map((node) => asString(node.data.url))
      .filter(Boolean)
    const hosts = flowHttpHosts(urls)
    if (hosts.length > 0) {
      const ok = window.confirm(t('flows.confirmHosts', { hosts: hosts.join(', ') }))
      if (!ok) return
    }
    const allowlistHosts = await flowHttpAllowlist(folder).catch(() => [])
    useFlowsStore.getState().setRunning(true)
    try {
      const result = await runLiveFlow({
        graph,
        folder,
        allowLoopback,
        confirmedHosts: hosts,
        allowlistHosts,
        agent: { project, cwd: folder },
      })
      useFlowsStore.getState().setRunResult(result.nodeOutputs, null)
    } catch (cause) {
      useFlowsStore.getState().setRunResult({}, String(cause instanceof Error ? cause.message : cause))
    }
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className={styles.view}>
        <aside className={styles.palette}>
          <p className={styles.kicker}>{t('flows.kicker')}</p>
          <div className={styles.titleRow}>
            <h1>{t('flows.title')}</h1>
            <span className={styles.beta}>{t('flows.beta')}</span>
          </div>
          <p className={styles.lede}>{t('flows.lede')}</p>
          {PALETTE.map((item) => (
            <PaletteItem key={item.type} type={item.type} label={t(item.labelKey)} />
          ))}
        </aside>
        <section className={styles.stageWrap}>
          <div className={styles.toolbar}>
            <select
              value={graph?.id ?? ''}
              onChange={(event) => useFlowsStore.getState().setActiveGraph(event.target.value)}
              aria-label={t('flows.graph')}
            >
              {graphs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => project && folder && useFlowsStore.getState().createGraph(folder, project.id)}
            >
              {t('flows.new')}
            </button>
            <button type="button" className={styles.primary} onClick={() => void run()} disabled={running || !graph}>
              {running ? t('flows.running') : t('flows.run')}
            </button>
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div
            ref={(node) => {
              containerRef.current = node
              setCanvasDropRef(node)
            }}
            className={`${styles.canvas} ${zoom.panning ? styles.canvasPanning : ''}`}
            onPointerDown={zoom.onCanvasPointerDown}
            onPointerMove={zoom.onCanvasPointerMove}
            onPointerUp={zoom.endPan}
            onPointerCancel={zoom.endPan}
          >
            <div
              ref={stageRef}
              className={styles.stage}
              style={{ transform: `translate(${zoom.pan.x}px, ${zoom.pan.y}px) scale(${zoom.zoom})` }}
            >
              <svg className={styles.edges} aria-hidden>
                {graph?.edges.map((edge) => {
                  const from = graph.nodes.find((node) => node.id === edge.from)
                  const to = graph.nodes.find((node) => node.id === edge.to)
                  if (!from || !to) return null
                  const a = portCenter(from, 'out')
                  const b = portCenter(to, 'in')
                  const mid = (b.x - a.x) / 2
                  const d = `M ${a.x} ${a.y} C ${a.x + mid} ${a.y}, ${b.x - mid} ${b.y}, ${b.x} ${b.y}`
                  return (
                    <g key={edge.id}>
                      <path className={styles.edgeHit} d={d} onClick={() => useFlowsStore.getState().removeEdge(folder, edge.id)} />
                      <path className={styles.edge} d={d} />
                    </g>
                  )
                })}
              </svg>
              {graph?.nodes.map((node) => (
                <article
                  key={node.id}
                  data-no-pan
                  className={`${styles.node} ${selectedNodeId === node.id ? styles.nodeSelected : ''}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => useFlowsStore.getState().setSelectedNode(node.id)}
                >
                  <div className={styles.nodeHead} onPointerDown={(event) => startNodeDrag(node, event)}>
                    <span>{t(`flows.node.${node.type === 'mcpTool' ? 'mcp' : node.type}` as MessageKey)}</span>
                    <button type="button" onClick={() => useFlowsStore.getState().removeNode(folder, node.id)}>
                      ×
                    </button>
                  </div>
                  <div className={styles.nodeBody}>
                    <p className={styles.output}>
                      {nodeOutputs[node.id] ?? asString(node.data.prompt || node.data.template || node.data.url)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${styles.port} ${styles.portIn} ${pendingFrom && pendingFrom !== node.id ? styles.portPending : ''}`}
                    aria-label={t('flows.portIn')}
                    onClick={() => clickPort(node.id, 'in')}
                  />
                  <button
                    type="button"
                    className={`${styles.port} ${styles.portOut} ${pendingFrom === node.id ? styles.portPending : ''}`}
                    aria-label={t('flows.portOut')}
                    onClick={() => clickPort(node.id, 'out')}
                  />
                </article>
              ))}
            </div>
          </div>
        </section>
        <aside className={styles.inspector}>
          <p className={styles.kicker}>{t('flows.inspector')}</p>
          {!selected ? (
            <p className={styles.empty}>{t('flows.inspectorEmpty')}</p>
          ) : (
            <NodeInspector node={selected} folder={folder} serverNames={serverNames} />
          )}
        </aside>
      </div>
    </DndContext>
  )
}

function NodeInspector({
  node,
  folder,
  serverNames,
}: {
  node: FlowNode
  folder: string
  serverNames: string[]
}) {
  const t = useT()
  const patch = (data: Record<string, unknown>) =>
    useFlowsStore.getState().patchNodeData(folder, node.id, data)
  if (node.type === 'agent') {
    const toolSelection: TaskToolSelection = (node.data.toolSelection as TaskToolSelection | undefined) ?? {
      mode: 'projectDefault',
      mcpServerIds: [],
      skillNames: [],
    }
    return (
      <>
        <label className={styles.field}>
          {t('flows.field.prompt')}
          <textarea
            value={asString(node.data.prompt)}
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </label>
        <TaskToolPicker
          cwd={folder}
          toolSelection={toolSelection}
          onChange={(next) => patch({ toolSelection: next })}
        />
      </>
    )
  }
  if (node.type === 'text') {
    return (
      <label className={styles.field}>
        {t('flows.field.template')}
        <textarea
          value={asString(node.data.template)}
          onChange={(event) => patch({ template: event.target.value })}
        />
      </label>
    )
  }
  if (node.type === 'filter') {
    return (
      <>
        <label className={styles.field}>
          {t('flows.field.includes')}
          <input
            value={asString(node.data.includes)}
            onChange={(event) => patch({ includes: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          {t('flows.field.regex')}
          <input
            value={asString(node.data.regex)}
            onChange={(event) => patch({ regex: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          {t('flows.field.jsonPath')}
          <input
            value={asString(node.data.jsonPath)}
            onChange={(event) => patch({ jsonPath: event.target.value })}
          />
        </label>
      </>
    )
  }
  if (node.type === 'http') {
    return (
      <>
        <label className={styles.field}>
          {t('flows.field.method')}
          <select
            value={asString(node.data.method) || 'POST'}
            onChange={(event) => patch({ method: event.target.value })}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {t('flows.field.url')}
          <input
            value={asString(node.data.url)}
            onChange={(event) => patch({ url: event.target.value })}
          />
        </label>
      </>
    )
  }
  return (
    <>
      <label className={styles.field}>
        {t('flows.field.server')}
        <select
          value={asString(node.data.serverId)}
          onChange={(event) => patch({ serverId: event.target.value })}
        >
          <option value="">{t('flows.field.serverEmpty')}</option>
          {serverNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        {t('flows.field.tool')}
        <input
          value={asString(node.data.toolName)}
          onChange={(event) => patch({ toolName: event.target.value })}
        />
      </label>
    </>
  )
}
