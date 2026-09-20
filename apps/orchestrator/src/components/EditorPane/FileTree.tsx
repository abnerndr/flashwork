import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getLocale, translate, useT } from '../../lib/i18n'
import { type WorkspaceEntry, workspaceList } from '../../lib/tauri'
import styles from './EditorPane.module.css'
import { workspaceErrorKey } from './workspaceError'

type FileTreeProps = {
  root: string
  activeRel: string | null
  onOpenFile: (entry: WorkspaceEntry) => void
}

type DirState = {
  entries?: WorkspaceEntry[]
  error?: string
  loading: boolean
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function FileTree({ root, activeRel, onOpenFile }: FileTreeProps) {
  const t = useT()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [dirs, setDirs] = useState<Record<string, DirState>>({})

  const loadDir = useCallback(
    async (rel: string) => {
      setDirs((current) => ({ ...current, [rel]: { ...current[rel], loading: true, error: undefined } }))
      try {
        const entries = sortEntries(await workspaceList(root, rel))
        setDirs((current) => ({ ...current, [rel]: { entries, loading: false } }))
      } catch (error) {
        setDirs((current) => ({
          ...current,
          [rel]: {
            loading: false,
            error: translate(getLocale(), workspaceErrorKey(error, 'editor.errListFailed')),
          },
        }))
      }
    },
    [root],
  )
  const loadDirRef = useRef(loadDir)
  loadDirRef.current = loadDir

  useEffect(() => {
    setExpanded(new Set(['']))
    setDirs({})
    void loadDirRef.current('')
  }, [root])

  const toggleDir = (rel: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
    const state = dirs[rel]
    if (!state?.entries && !state?.loading) void loadDir(rel)
  }

  const renderEntries = (rel: string, depth: number) => {
    const state = dirs[rel]
    if (!state || (state.loading && !state.entries)) {
      return <div className={styles.treeMessage}>{t('editor.treeLoading')}</div>
    }
    if (state.error && !state.entries) {
      return <div className={styles.treeError}>{state.error}</div>
    }
    const entries = state.entries ?? []
    if (!state.loading && entries.length === 0) {
      return <div className={styles.treeMessage}>{t('editor.treeEmpty')}</div>
    }
    return entries.map((entry) => {
      const open = entry.isDir && expanded.has(entry.rel)
      const active = !entry.isDir && entry.rel === activeRel
      return (
        <div key={entry.rel}>
          <button
            type="button"
            className={`${styles.row} ${active ? styles.rowActive : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (entry.isDir ? toggleDir(entry.rel) : onOpenFile(entry))}
            title={entry.rel || entry.name}
          >
            <span className={styles.rowIcon}>
              {entry.isDir ? (
                open ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <File size={14} />
              )}
            </span>
            {entry.isDir ? (
              <span className={styles.rowIcon}>
                {open ? <FolderOpen size={14} /> : <Folder size={14} />}
              </span>
            ) : null}
            <span className={styles.rowLabel}>{entry.name}</span>
          </button>
          {open ? renderEntries(entry.rel, depth + 1) : null}
        </div>
      )
    })
  }

  return (
    <aside className={styles.tree}>
      <div className={styles.treeTitle}>{t('editor.treeTitle')}</div>
      <div className={styles.treeBody}>{renderEntries('', 0)}</div>
    </aside>
  )
}
