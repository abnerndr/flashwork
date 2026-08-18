import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { buildHandoffTerminalArgs } from '../../lib/promptRun/executeHandoff'
import {
  completeAgentHandoff,
  type HandoffDraft,
  type HandoffProvider,
  materializeAgentHandoff,
  prepareAgentHandoff,
  readTextFile,
} from '../../lib/tauri'
import { AGENT_TYPE_LABELS, UNRESTRICTED_FLAG } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './HandoffModal.module.css'
import { Modal } from './Modal'

const MAX_HANDOFF_BYTES = 64 * 1024

function targetFor(source: HandoffProvider): HandoffProvider {
  return source === 'claude' ? 'codex' : 'claude'
}

export function HandoffModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'handoff')
  const context = useUiStore((state) => state.modalContext)
  const closeModal = useUiStore((state) => state.closeModal)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const projects = useProjectsStore((state) => state.projects)
  const createTerminal = useProjectsStore((state) => state.createTerminal)
  const unrestrictedDefault = useProjectsStore(
    (state) => state.preferences.alwaysStartUnrestricted,
  )

  const [draft, setDraft] = useState<HandoffDraft | null>(null)
  const [content, setContent] = useState('')
  const [unrestricted, setUnrestricted] = useState(unrestrictedDefault)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewReady, setReviewReady] = useState(false)

  const source = context?.agent === 'codex' ? 'codex' : 'claude'
  const target = targetFor(source)
  const projectId = typeof context?.projectId === 'string' ? context.projectId : ''
  const terminalId = typeof context?.terminalId === 'string' ? context.terminalId : ''
  const requestedSessionId =
    typeof context?.sourceSessionId === 'string' ? context.sourceSessionId : undefined
  const reviewPath = typeof context?.reviewPath === 'string' ? context.reviewPath : ''
  const isReview = reviewPath.length > 0
  const project = projects.find((entry) => entry.id === projectId) ?? null
  const terminal = project?.terminals.find((entry) => entry.id === terminalId) ?? null
  const activeTab = terminal?.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal?.tabs[0]
  const cwd = activeTab?.cwd || terminal?.cwd || project?.defaultCwd || ''
  const sourceSessionId = requestedSessionId || activeTab?.sessionId
  const byteCount = useMemo(() => new TextEncoder().encode(content).length, [content])
  const warnings = draft
    ? [
        t('handoff.lossPrivate'),
        ...(draft.usedFallback ? [t('handoff.fallbackNewest')] : []),
        ...(draft.omittedEventCount > 0
          ? [t('handoff.lossOmitted', { count: draft.omittedEventCount })]
          : []),
        ...(draft.redactionCount > 0
          ? [t('handoff.lossRedacted', { count: draft.redactionCount })]
          : []),
      ]
    : []

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setDraft(null)
    setContent('')
    setError(null)
    setUnrestricted(unrestrictedDefault)
    setReviewReady(false)
    if (isReview) {
      void readTextFile(reviewPath)
        .then((text) => {
          if (!cancelled) setContent(text)
        })
        .catch((cause) => {
          if (!cancelled) setError(String(cause))
        })
        .finally(() => {
          if (!cancelled) setReviewReady(true)
        })
      return () => {
        cancelled = true
      }
    }
    if (!cwd) return
    void prepareAgentHandoff({
      sourceProvider: source,
      targetProvider: target,
      sourceSessionId,
      cwd,
    })
      .then((result) => {
        if (cancelled) return
        setDraft(result)
        setContent(result.content)
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, source, target, sourceSessionId, unrestrictedDefault, isReview, reviewPath])

  const continueInTarget = async () => {
    if (!draft || !project || !content.trim() || byteCount > MAX_HANDOFF_BYTES) return
    setBusy(true)
    setError(null)
    let artifact: Awaited<ReturnType<typeof materializeAgentHandoff>> | null = null
    try {
      artifact = await materializeAgentHandoff(content)
      const permissionFlag = unrestricted ? UNRESTRICTED_FLAG[target] : null
      const created = createTerminal(
        project.id,
        buildHandoffTerminalArgs({
          target,
          cwd: draft.cwd,
          bootstrap: t('handoff.bootstrapPrompt', { path: artifact.contextPath }),
          extraArgs: permissionFlag ? [permissionFlag] : [],
          handoff: {
            id: artifact.handoffId,
            contextDir: artifact.contextDir,
            contextPath: artifact.contextPath,
            sourceProvider: source,
            sourceSessionId: draft.sourceSessionId,
          },
          paneName: t('handoff.paneName', { agent: AGENT_TYPE_LABELS[target] }),
        }),
      )
      setActiveTerminal(project.id, created.id)
      requestPaneFocus(created.id)
      closeModal()
    } catch (cause) {
      if (artifact) await completeAgentHandoff(artifact.handoffId).catch(() => {})
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const showEditor = isReview ? reviewReady : Boolean(draft)

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('handoff.title', { source: AGENT_TYPE_LABELS[source], target: AGENT_TYPE_LABELS[target] })}
      width={720}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={closeModal} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={isReview ? closeModal : () => void continueInTarget()}
            disabled={
              isReview ? false : !draft || busy || !content.trim() || byteCount > MAX_HANDOFF_BYTES
            }
          >
            {isReview
              ? t('common.close')
              : busy
                ? t('handoff.starting')
                : t('handoff.continue', { agent: AGENT_TYPE_LABELS[target] })}
          </button>
        </>
      }
    >
      {!isReview && !cwd ? <div className={styles.error}>{t('handoff.noCwd')}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {!isReview && !draft && !error ? <div className={styles.loading}>{t('handoff.preparing')}</div> : null}
      {isReview && !reviewReady && !error ? <div className={styles.loading}>{t('handoff.preparing')}</div> : null}
      {showEditor ? (
        <div className={styles.content}>
          {draft ? (
            <div className={styles.summary}>
              <span>{t('handoff.session', { id: draft.sourceSessionId.slice(0, 8) })}</span>
              <span>{t('handoff.included', { count: draft.includedEventCount })}</span>
              <span>{t('handoff.omitted', { count: draft.omittedEventCount })}</span>
              <span>{t('handoff.redacted', { count: draft.redactionCount })}</span>
            </div>
          ) : null}
          {warnings.length ? (
            <ul className={styles.warnings}>
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          <label className={styles.label} htmlFor="handoff-content">
            {t('handoff.reviewLabel')}
          </label>
          <textarea
            id="handoff-content"
            className={styles.editor}
            value={content}
            onChange={isReview ? undefined : (event) => setContent(event.target.value)}
            readOnly={isReview}
            spellCheck={false}
          />
          {!isReview ? (
            <>
              <div className={`${styles.counter} ${byteCount > MAX_HANDOFF_BYTES ? styles.counterError : ''}`}>
                {t('handoff.size', { current: byteCount, max: MAX_HANDOFF_BYTES })}
              </div>
              <label className={styles.unrestricted}>
                <input
                  type="checkbox"
                  checked={unrestricted}
                  onChange={(event) => setUnrestricted(event.target.checked)}
                />
                {t('handoff.unrestricted', { agent: AGENT_TYPE_LABELS[target] })}
              </label>
              <p className={styles.privacy}>{t('handoff.privacy')}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
