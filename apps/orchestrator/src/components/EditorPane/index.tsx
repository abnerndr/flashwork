import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import { type WorkspaceEntry, workspaceRead, workspaceWrite } from '../../lib/tauri'
import type { Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './EditorPane.module.css'
import {
  type ReadError,
  readErrorPlacement,
  resolveFailedOpen,
  shouldCloseBuffer,
} from './editorPaneLogic'
import { EditorTabs } from './EditorTabs'
import { FileTree } from './FileTree'
import { languageForPath } from './languageForPath'
import { isFileTooLarge, workspaceErrorKey } from './workspaceError'

const MonacoHost = lazy(() => import('./MonacoHost'))

export type EditorBuffer = {
  rel: string
  name: string
  value: string
  savedValue: string
  language: string
}

export type EditorPaneProps = {
  projectId: string
  terminal: Terminal
}

export default function EditorPane({ projectId, terminal }: EditorPaneProps) {
  const t = useT()
  const root = terminal.cwd
  const uiTheme = useProjectsStore((state) => state.preferences.uiTheme)
  const pushToast = useUiStore((state) => state.pushToast)
  const editorOpenRequest = useUiStore((state) => state.editorOpenRequest)
  const focusRequest = useUiStore((state) => state.focusRequest)
  const [buffers, setBuffers] = useState<EditorBuffer[]>([])
  const [activeRel, setActiveRel] = useState<string | null>(null)
  const [readError, setReadError] = useState<ReadError | null>(null)
  const paneRef = useRef<HTMLElement | null>(null)
  const lastOpenTs = useRef<number | null>(null)

  const active = buffers.find((buffer) => buffer.rel === activeRel) ?? null
  const errorPlacement = readErrorPlacement(readError, activeRel)

  const updateBuffer = useCallback((rel: string, patch: Partial<EditorBuffer>) => {
    setBuffers((current) =>
      current.map((buffer) => (buffer.rel === rel ? { ...buffer, ...patch } : buffer)),
    )
  }, [])

  const openFile = useCallback(
    async (target: WorkspaceEntry | string) => {
      const entry: WorkspaceEntry =
        typeof target === 'string'
          ? { rel: target.replace(/\\/g, '/'), name: basename(target) || target, isDir: false }
          : target
      if (entry.isDir || !entry.rel) return
      const existing = buffers.find((buffer) => buffer.rel === entry.rel)
      if (existing) {
        setReadError(null)
        setActiveRel(entry.rel)
        return
      }
      try {
        const value = await workspaceRead(root, entry.rel)
        setReadError(null)
        setBuffers((current) => [
          ...current.filter((buffer) => buffer.rel !== entry.rel),
          {
            rel: entry.rel,
            name: entry.name,
            value,
            savedValue: value,
            language: languageForPath(entry.rel),
          },
        ])
        setActiveRel(entry.rel)
      } catch (error) {
        const key = workspaceErrorKey(error, 'editor.errReadFailed')
        const message = t(key)
        const tooLarge = isFileTooLarge(error)
        const result = resolveFailedOpen({
          failedRel: entry.rel,
          message,
          tooLarge,
          activeRel,
        })
        setReadError(result.readError)
        if (result.toast) {
          pushToast({
            title: t(tooLarge ? 'editor.errFileTooLarge' : 'editor.errReadFailed'),
            body: message,
          })
        }
      }
    },
    [activeRel, buffers, pushToast, root, t],
  )

  useEffect(() => {
    if (!editorOpenRequest) return
    if (editorOpenRequest.projectId !== projectId) return
    if (lastOpenTs.current === editorOpenRequest.ts) return
    lastOpenTs.current = editorOpenRequest.ts
    void openFile(editorOpenRequest.rel)
  }, [editorOpenRequest, openFile, projectId])

  useEffect(() => {
    if (!focusRequest || focusRequest.terminalId !== terminal.id) return
    paneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [focusRequest, terminal.id])

  const saveActive = useCallback(async () => {
    if (!active || active.value === active.savedValue) return
    try {
      await workspaceWrite(root, active.rel, active.value)
      updateBuffer(active.rel, { savedValue: active.value })
      setReadError(null)
    } catch (error) {
      const message = t(workspaceErrorKey(error, 'editor.errWriteFailed'))
      pushToast({ title: t('editor.errWriteFailed'), body: message })
    }
  }, [active, pushToast, root, t, updateBuffer])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      const pane = paneRef.current
      if (!pane) return
      const target = event.target
      if (!(target instanceof Node) || !pane.contains(target)) return
      event.preventDefault()
      event.stopPropagation()
      void saveActive()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [saveActive])

  const closeTab = (rel: string) => {
    const buffer = buffers.find((item) => item.rel === rel)
    if (
      !shouldCloseBuffer(buffer, () =>
        window.confirm(t('editor.confirmCloseDirty', { name: buffer?.name ?? rel })),
      )
    ) {
      return
    }
    setBuffers((current) => {
      const next = current.filter((item) => item.rel !== rel)
      if (activeRel === rel) setActiveRel(next[next.length - 1]?.rel ?? null)
      return next
    })
    setReadError((current) => (current?.rel === rel ? null : current))
  }

  return (
    <section ref={paneRef} className={styles.root} tabIndex={0}>
      <FileTree root={root} activeRel={activeRel} onOpenFile={(entry) => void openFile(entry)} />
      <div className={styles.main}>
        <EditorTabs
          tabs={buffers.map((buffer) => ({
            rel: buffer.rel,
            name: buffer.name,
            dirty: buffer.value !== buffer.savedValue,
          }))}
          activeRel={activeRel}
          onSelect={(rel) => {
            setReadError(null)
            setActiveRel(rel)
          }}
          onClose={closeTab}
        />
        {errorPlacement === 'banner' && readError ? (
          <div className={styles.inlineBanner}>{readError.message}</div>
        ) : null}
        <div className={styles.editor}>
          {errorPlacement === 'inline' && readError ? (
            <div className={styles.inlineError}>{readError.message}</div>
          ) : active ? (
            <Suspense fallback={<div className={styles.placeholder}>{t('editor.loading')}</div>}>
              <MonacoHost
                value={active.value}
                language={active.language}
                path={active.rel}
                theme={uiTheme}
                onChange={(value) => updateBuffer(active.rel, { value })}
                onSave={() => void saveActive()}
              />
            </Suspense>
          ) : (
            <div className={styles.placeholder}>{t('editor.empty')}</div>
          )}
        </div>
      </div>
    </section>
  )
}
