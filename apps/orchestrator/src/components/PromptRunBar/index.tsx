import { useEffect } from 'react'

import { useT, type MessageKey } from '../../lib/i18n'
import {
  AGENT_TYPE_LABELS,
  type PromptRunStatus,
  type PromptRunStep,
  type PromptRunStepReason,
} from '../../lib/types'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './PromptRunBar.module.css'

const VISIBLE_STATUSES: ReadonlySet<PromptRunStatus> = new Set([
  'running',
  'handing-off',
  'waiting',
  'failed',
])

const STATUS_KEYS: Record<PromptRunStatus, MessageKey> = {
  running: 'promptRun.status.running',
  'handing-off': 'promptRun.status.handing-off',
  waiting: 'promptRun.status.waiting',
  done: 'promptRun.status.done',
  failed: 'promptRun.status.failed',
  cancelled: 'promptRun.status.cancelled',
}

const REASON_KEYS: Record<PromptRunStepReason, MessageKey> = {
  heuristic: 'promptRun.reason.heuristic',
  quota: 'promptRun.reason.quota',
  error: 'promptRun.reason.error',
  user: 'promptRun.reason.user',
  'only-installed': 'promptRun.reason.only-installed',
  'project-preference': 'promptRun.reason.project-preference',
  'last-used': 'promptRun.reason.last-used',
}

function reviewCapsule(steps: PromptRunStep[]): {
  contextPath?: string
  sourceAgent?: PromptRunStep['agent']
} {
  let contextPath: string | undefined
  let sourceAgent: PromptRunStep['agent'] | undefined
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const path = steps[index]?.contextPath
    if (!path) continue
    contextPath = path
    sourceAgent = index > 0 ? steps[index - 1]?.agent : undefined
    break
  }
  return { contextPath, sourceAgent }
}

export type PromptRunBarProps = {
  projectId: string
}

export function PromptRunBar({ projectId }: PromptRunBarProps) {
  const t = useT()
  const run = usePromptRunStore((state) => state.byProjectId[projectId])
  const setStatus = usePromptRunStore((state) => state.setStatus)
  const openModal = useUiStore((state) => state.openModal_)

  useEffect(() => {
    void usePromptRunStore.getState().hydrate(projectId)
  }, [projectId])

  if (!run || !VISIBLE_STATUSES.has(run.status)) return null

  const lastStep = run.steps[run.steps.length - 1]
  const capsule = reviewCapsule(run.steps)
  const failed = run.status === 'failed'

  return (
    <div className={styles.bar} data-prompt-run-bar={projectId}>
      <div className={styles.meta}>
        <span className={styles.title}>{t('promptRun.barTitle')}</span>
        <span className={styles.agent}>{AGENT_TYPE_LABELS[run.activeAgent]}</span>
        <span className={`${styles.status} ${failed ? styles.statusFailed : ''}`}>
          <span className={styles.dot} />
          {t(STATUS_KEYS[run.status])}
        </span>
        {lastStep ? <span className={styles.reason}>{t(REASON_KEYS[lastStep.reason])}</span> : null}
      </div>
      {run.steps.length > 0 ? (
        <div className={styles.timeline}>
          {run.steps.map((step, index) => (
            <span key={`${step.agent}-${step.startedAt}-${index}`} className={styles.step}>
              {AGENT_TYPE_LABELS[step.agent]} · {t(REASON_KEYS[step.reason])}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.review}
          disabled={!capsule.contextPath}
          onClick={() => {
            if (!capsule.contextPath) return
            openModal('handoff', {
              reviewPath: capsule.contextPath,
              projectId,
              agent: capsule.sourceAgent,
            })
          }}
        >
          {t('promptRun.reviewCapsule')}
        </button>
        <button
          type="button"
          className={styles.stop}
          onClick={() => setStatus(projectId, 'cancelled')}
        >
          {t('promptRun.cancel')}
        </button>
      </div>
    </div>
  )
}
