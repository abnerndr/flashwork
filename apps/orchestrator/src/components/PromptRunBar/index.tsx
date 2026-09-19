import { Route, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT, type MessageKey } from '../../lib/i18n'
import { isPromptRunBlocking } from '../../lib/promptRun/isPromptRunBlocking'
import { promptRunOutcomeToast } from '../../lib/promptRun/promptRunToast'
import { submitAutoPromptRun, toAutoPromptRunProject } from '../../lib/promptRun/submitAutoPromptRun'
import { isApiAgentId, isApiTerminalId, routedAgentLabel } from '../../lib/promptRun/routedAgent'
import {
  AGENT_TYPE_LABELS,
  ALL_AGENT_TYPES,
  type AgentType,
  type PromptRunStatus,
  type PromptRunStep,
  type PromptRunStepReason,
} from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentInstallModal } from '../AgentInstall/AgentInstallModal'
import styles from './PromptRunBar.module.css'

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
}

export function PromptRunBar({ projectId }: PromptRunBarProps) {
  const t = useT()
  const run = usePromptRunStore((state) => state.byProjectId[projectId])
  const setStatus = usePromptRunStore((state) => state.setStatus)
  const project = useProjectsStore((state) => state.projects.find((item) => item.id === projectId))
  const preferences = useProjectsStore((state) => state.preferences)
  const openModal = useUiStore((state) => state.openModal_)
  const pushToast = useUiStore((state) => state.pushToast)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const promptRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [installAgent, setInstallAgent] = useState<AgentType | null>(null)

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const prompt = promptRef.current?.value.trim() ?? ''
    if (!prompt || submittingRef.current) return
    const current =
      useProjectsStore.getState().projects.find((item) => item.id === projectId) ?? null
    submittingRef.current = true
    setSubmitting(true)
    try {
      const result = await submitAutoPromptRun({
        project: toAutoPromptRunProject(current),
        cwd: getProjectDefaultCwd(current, useProjectsStore.getState().projects),
        prompt,
        unrestricted: run?.unrestricted ?? false,
      })
      if (!result.ok) {
        if (result.code === 'no-cwd') {
          pushToast({ title: t('promptRun.noCwdTitle'), body: t('promptRun.noCwdBody') })
          return
        }
        if (result.code === 'run-active') {
          pushToast({
            title: t('promptRun.runActiveTitle'),
            body: t('promptRun.runActiveBody'),
          })
          return
        }
        if (result.code === 'needs-install') {
          const candidate = preferences.enabledAgents.claude
            ? 'claude'
            : (ALL_AGENT_TYPES.find(
                (agent) => agent !== 'shell' && preferences.enabledAgents[agent],
              ) ?? 'claude')
          setInstallAgent(candidate)
          pushToast({
            title: t('promptRun.needsInstallTitle'),
            body: t('promptRun.needsInstallBody'),
          })
          return
        }
        if (result.code === 'needs-setup-api') {
          openModal('preferences', { category: 'providers' })
          pushToast({
            title: t('promptRun.needsSetupApiTitle'),
            body: t('promptRun.needsSetupApiBody'),
          })
          return
        }
        return
      }
      const skipFocus =
        isApiAgentId(result.run.activeAgent) || isApiTerminalId(result.run.activeTerminalId)
      if (!skipFocus) {
        useProjectsStore
          .getState()
          .focusWorkspaceTerminal(result.run.projectId, result.run.activeTerminalId)
        setActiveTerminal(result.run.projectId, result.run.activeTerminalId)
        requestPaneFocus(result.run.activeTerminalId)
      }
      if (promptRef.current) promptRef.current.value = ''
      const reason = result.run.steps[0]?.reason ?? 'heuristic'
      const outcome = promptRunOutcomeToast(result.run.status)
      pushToast({
        title: t(outcome.titleKey),
        body: t(outcome.bodyKey, {
          agent: routedAgentLabel(result.run.activeAgent),
          reason: t(REASON_KEYS[reason]),
        }),
      })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.bar} data-prompt-run-bar={projectId}>
      {blocking && run ? (
        <>
          <div className={styles.meta}>
            <span className={styles.title}>{t('promptRun.barTitle')}</span>
            <span className={styles.agent}>{routedAgentLabel(run.activeAgent)}</span>
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
        </>
      ) : (
        <form className={styles.composer} onSubmit={(event) => void submit(event)}>
          <Route size={13} className={styles.composerIcon} aria-hidden="true" />
          <input
            ref={promptRef}
            className={styles.composerInput}
            placeholder={t('promptRun.composerPlaceholder')}
            aria-label={t('promptRun.composerPlaceholder')}
            disabled={submitting}
            required
          />
          <button
            type="submit"
            className={styles.composerSend}
            disabled={submitting}
            title={t('promptRun.composerSend')}
            aria-label={t('promptRun.composerSend')}
          >
            <Send size={12} />
            {t('promptRun.composerSend')}
          </button>
        </form>
      )}
      {installAgent ? (
        <AgentInstallModal
          agent={installAgent}
          label={AGENT_TYPE_LABELS[installAgent]}
          open
          onClose={() => setInstallAgent(null)}
        />
      ) : null}
    </div>
  )
}
