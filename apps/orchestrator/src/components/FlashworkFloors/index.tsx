import { GitBranch, Layers, Plus, TerminalSquare, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  worktreeList,
  worktreeProvision,
  worktreeRemove,
  type WorktreeInfo,
} from '../../lib/tauri/git'
import styles from './FlashworkFloors.module.css'

function nextFloorId(existing: WorktreeInfo[]): string {
  const used = new Set(existing.map((item) => item.agentId))
  for (let index = 1; index < 100; index += 1) {
    const id = `floor-${index}`
    if (!used.has(id)) return id
  }
  return `floor-${Date.now().toString(36)}`
}

export function FlashworkFloors() {
  const projects = useProjectsStore((state) => state.projects)
  const createAgentTerminal = useProjectsStore((state) => state.createAgentTerminal)
  const setActiveProjectOnly = useProjectsStore((state) => state.setActiveProjectOnly)
  const focusWorkspaceTerminal = useProjectsStore((state) => state.focusWorkspaceTerminal)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)

  const project = projects[0]
  const repo = useMemo(
    () => (project ? getProjectDefaultCwd(project, projects) : ''),
    [project, projects],
  )

  const [floors, setFloors] = useState<WorktreeInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!repo) {
      setFloors([])
      return
    }
    try {
      const list = await worktreeList(repo)
      setFloors(list)
      setError(null)
    } catch (cause) {
      setError(String(cause))
    }
  }, [repo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createFloor = async () => {
    if (!repo || !project) return
    setBusy(true)
    setError(null)
    try {
      const info = await worktreeProvision(repo, nextFloorId(floors), 'gitWorktree')
      setFloors((current) => [...current, info])
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openFloorShell = async (floor: WorktreeInfo) => {
    if (!project) return
    const terminal = await createAgentTerminal(project.id, {
      name: `Floor ${floor.agentId}`,
      cwd: floor.path,
      firstTab: { type: 'shell', cwd: floor.path },
    })
    setActiveProjectOnly(project.id)
    focusWorkspaceTerminal(project.id, terminal.id)
    setActiveTerminal(project.id, terminal.id)
    requestPaneFocus(terminal.id)
    setActiveView('workspace')
  }

  const removeFloor = async (floor: WorktreeInfo) => {
    if (!repo) return
    setBusy(true)
    try {
      await worktreeRemove(repo, floor.agentId, true)
      setFloors((current) => current.filter((item) => item.agentId !== floor.agentId))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="flashwork-floors-title">
      <header className={styles.header}>
        <div>
          <h2 id="flashwork-floors-title" className={styles.title}>
            Floors
          </h2>
          <p className={styles.sub}>
            Isolated git worktrees for parallel agents. Stored under{' '}
            <code>.flashwork/worktrees/</code>.
          </p>
        </div>
        <button
          type="button"
          className={styles.primary}
          onClick={() => void createFloor()}
          disabled={!repo || busy}
        >
          <Plus size={16} />
          New Floor
        </button>
      </header>

      {!repo ? (
        <p className={styles.empty}>Create or open a project first — Floors attach to its repo.</p>
      ) : floors.length === 0 ? (
        <p className={styles.empty}>No floors yet. Create one to isolate an agent worktree.</p>
      ) : (
        <ul className={styles.list}>
          {floors.map((floor) => (
            <li key={floor.agentId} className={styles.row}>
              <Layers size={16} className={styles.icon} />
              <div className={styles.meta}>
                <strong>{floor.agentId}</strong>
                <span>
                  <GitBranch size={16} /> {floor.branch || 'detached'}
                </span>
              </div>
              <div className={styles.actions}>
                <button type="button" onClick={() => void openFloorShell(floor)} title="Open shell">
                  <TerminalSquare size={16} />
                </button>
                <button type="button" onClick={() => void removeFloor(floor)} title="Remove floor">
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  )
}
