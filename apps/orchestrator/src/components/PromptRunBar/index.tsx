import { ListChecks } from 'lucide-react'
import { useEffect } from 'react'

import { useT, type MessageKey } from '../../lib/i18n'
import { resolveCliSessionSnapshot } from '../../lib/cliSessionLimit'
import { isPromptRunBlocking } from '../../lib/promptRun/isPromptRunBlocking'
import { isApiAgentId, routedAgentLabel } from '../../lib/promptRun/routedAgent'
import {
  type PromptRunStatus,
  type PromptRunStep,
  type PromptRunStepReason,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './PromptRunBar.module.css'

const STATUS_KEYS: Record<PromptRunStatus, MessageKey> = {
  running: 'promptRun.status.running',
  'handing-off': 'promptRun.status.handing-off',
  waiting: 'promptRun.status.waiting',
  done: 'promptRun.status.done',
  failed: 'promptRun.status.failed',
  cancelled: 'promptRun.status.cancelled',
  interrupted: 'promptRun.status.interrupted',
}

const REASON_KEYS: Record<PromptRunStepReason, MessageKey> = {
  heuristic: 'promptRun.reason.heuristic',
  quota: 'promptRun.reason.quota',
  error: 'promptRun.reason.error',
  user: 'promptRun.reason.user',
  'only-installed': 'promptRun.reason.only-installed',
  'project-preference': 'promptRun.reason.project-preference',
  'last-used': 'promptRun.reason.last-used',
  skill: 'promptRun.reason.skill',
  orchestrator: 'promptRun.reason.orchestrator',
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
  /** Show a Run SPEC entry while idle (used when the container header is hidden). */
  showRunSpecWhenIdle?: boolean
}

export function PromptRunBar({ projectId, showRunSpecWhenIdle = false }: PromptRunBarProps) {
  const t = useT()
  const run = usePromptRunStore((state) => state.byProjectId[projectId])
  const setStatus = usePromptRunStore((state) => state.setStatus)
  const project = useProjectsStore((state) => state.projects.find((item) => item.id === projectId))
  const openModal = useUiStore((state) => state.openModal_)
  const claudeUsage = useUiStore((state) => state.claudeUsage)
  const codexUsage = useUiStore((state) => state.codexUsage)
  const antigravityUsage = useUiStore((state) => state.antigravityUsage)
  const geminiUsage = useUiStore((state) => state.geminiUsage)
  const opencodeUsage = useUiStore((state) => state.opencodeUsage)

  useEffect(() => {
    void usePromptRunStore.getState().hydrate(projectId)
  }, [projectId])

  const liveTerminalIds = project?.terminals.map((terminal) => terminal.id)
  const blocking = isPromptRunBlocking(
    run?.status,
    [run?.activeTerminalId, ...(run?.steps.map((step) => step.terminalId) ?? [])].filter(
      (id): id is string => Boolean(id),
    ),
    liveTerminalIds,
  )
  const lastStep = run?.steps[run.steps.length - 1]
  const capsule = run ? reviewCapsule(run.steps) : {}
  const failed = run?.status === 'failed'
  const activeSession =
    run && !isApiAgentId(run.activeAgent)
      ? resolveCliSessionSnapshot(run.activeAgent, {
          claude: claudeUsage,
          codex: codexUsage,
          antigravity: antigravityUsage,
          gemini: geminiUsage,
          opencode: opencodeUsage,
        })
      : null

  if (!blocking || !run) {
    if (!showRunSpecWhenIdle) return null
    return (
      <div className={styles.bar} data-prompt-run-bar={projectId}>
        <button
          type="button"
          className={styles.runSpec}
          onClick={() => openModal('runSpec', { projectId })}
          title={t('runSpec.openHint')}
        >
          <ListChecks size={14} />
          {t('runSpec.open')}
        </button>
      </div>
    )
  }

  return (
    <div className={styles.bar} data-prompt-run-bar={projectId}>
      <div className={styles.meta}>
        <span className={styles.title}>{t('promptRun.barTitle')}</span>
        <span className={styles.agent}>{routedAgentLabel(run.activeAgent)}</span>
        {activeSession ? (
          <span
            className={`${styles.sessionLimit}${activeSession.critical ? ` ${styles.sessionLimitCritical}` : ''}`}
            title={t('promptRun.sessionLimitHint', {
              agent: routedAgentLabel(run.activeAgent),
              limit: activeSession.badge,
            })}
          >
            {activeSession.badge}
          </span>
        ) : null}
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
              {routedAgentLabel(step.agent)} · {t(REASON_KEYS[step.reason])}
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
