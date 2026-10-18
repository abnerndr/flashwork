import { FileText, Paperclip, Terminal, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { pickFile } from '../../lib/dialog'
import { useT, type MessageKey } from '../../lib/i18n'
import { launchSpecRun, planSpec, type SpecPlanNotice } from '../../lib/promptRun/runSpec'
import { removeSpecTask } from '../../lib/promptRun/specPlan'
import { readSpecMarkdown } from '../../lib/tauri'
import { AGENT_TYPE_LABELS, type AgentType, type SpecTask, type SpecTaskKind } from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './RunSpecModal.module.css'

const KIND_KEYS: Record<SpecTaskKind, MessageKey> = {
  implement: 'runSpec.kind.implement',
  review: 'runSpec.kind.review',
  mechanical: 'runSpec.kind.mechanical',
  explore: 'runSpec.kind.explore',
  ui: 'runSpec.kind.ui',
  shell: 'runSpec.kind.shell',
}

const NOTICE_KEYS: Record<SpecPlanNotice, MessageKey> = {
  'gemini-missing': 'runSpec.noticeGeminiMissing',
  'gemini-failed': 'runSpec.noticeGeminiFailed',
}

type Plan = {
  tasks: SpecTask[]
  agents: AgentType[]
  source: 'gemini' | 'heuristic'
  notice?: SpecPlanNotice
  spec: string
}

type Attachment = { name: string; content: string }

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function RunSpecModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'runSpec')
  const contextProjectId = useUiStore((state) => state.modalContext?.projectId)
  const closeModal = useUiStore((state) => state.closeModal)
  const pushToast = useUiStore((state) => state.pushToast)
  const projects = useProjectsStore((state) => state.projects)
  const [projectId, setProjectId] = useState('')
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState<'planning' | 'launching' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const wanted = typeof contextProjectId === 'string' ? contextProjectId : ''
    setProjectId(projects.some((project) => project.id === wanted) ? wanted : (projects[0]?.id ?? ''))
    setPlan(null)
    setError(null)
    // Keep the draft text between openings; only the project and plan reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contextProjectId])

  const project = projects.find((item) => item.id === projectId) ?? null
  const cwd = project ? getProjectDefaultCwd(project, projects) : ''
  const spec = useMemo(() => {
    const parts = [attachment?.content.trim() ?? '', text.trim()].filter(Boolean)
    return parts.join('\n\n')
  }, [attachment, text])
  const launchable = plan?.tasks.length ?? 0

  const close = () => {
    if (busy) return
    closeModal()
  }

  const attach = async () => {
    setError(null)
    const path = await pickFile({
      title: t('runSpec.attach'),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
    })
    if (!path) return
    try {
      const content = await readSpecMarkdown(path)
      setAttachment({ name: fileName(path), content })
      setPlan(null)
    } catch (cause) {
      setError(String(cause).includes('spec_too_large') ? t('runSpec.tooLarge') : t('runSpec.attachFailed'))
    }
  }

  const runPlanner = async () => {
    if (!project || !spec || busy) return
    setBusy('planning')
    setError(null)
    try {
      const result = await planSpec({ project, cwd, spec })
      if (!result.ok) {
        setError(
          result.code === 'no-cwd' ? t('promptRun.noCwdBody') : t('promptRun.needsInstallBody'),
        )
        return
      }
      setPlan({ ...result, spec })
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(null)
    }
  }

  const updateTask = (id: string, patch: Partial<SpecTask>) => {
    setPlan((current) =>
      current
        ? { ...current, tasks: current.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }
        : current,
    )
  }

  const removeTask = (id: string) => {
    setPlan((current) => (current ? { ...current, tasks: removeSpecTask(current.tasks, id) } : current))
  }

  const launch = async () => {
    if (!project || !plan || plan.tasks.length === 0 || busy) return
    setBusy('launching')
    setError(null)
    try {
      const result = await launchSpecRun({ project, cwd, spec: plan.spec, tasks: plan.tasks })
      if (!result.ok) {
        setError(
          result.code === 'run-active'
            ? t('promptRun.runActiveBody')
            : result.code === 'no-cwd'
              ? t('promptRun.noCwdBody')
              : t('promptRun.needsInstallBody'),
        )
        return
      }
      const store = useProjectsStore.getState()
      const ui = useUiStore.getState()
      store.setActiveProjectOnly(project.id)
      store.openContainerWithAllPanes(project.id)
      if (result.run.activeTerminalId) {
        store.focusWorkspaceTerminal(project.id, result.run.activeTerminalId)
        ui.setActiveTerminal(project.id, result.run.activeTerminalId)
        ui.requestPaneFocus(result.run.activeTerminalId)
      }
      ui.setActiveView('workspace')
      pushToast({
        title: t('runSpec.launchedTitle'),
        body: t('runSpec.launchedBody', {
          count: plan.tasks.length,
          board: result.run.boardPath ?? '—',
        }),
      })
      setText('')
      setAttachment(null)
      setPlan(null)
      closeModal()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(null)
    }
  }

  const footer = (
    <>
      <button type="button" className={controls.btn} onClick={close} disabled={busy !== null}>
        {t('runSpec.cancel')}
      </button>
      {plan ? (
        <button
          type="button"
          className={controls.btn}
          onClick={() => void runPlanner()}
          disabled={busy !== null || !spec}
        >
          {t('runSpec.replan')}
        </button>
      ) : null}
      {plan ? (
        <button
          type="button"
          className={controls.btnPrimary}
          onClick={() => void launch()}
          disabled={busy !== null || launchable === 0}
        >
          {busy === 'launching' ? t('runSpec.launching') : t('runSpec.launch', { count: launchable })}
        </button>
      ) : (
        <button
          type="button"
          className={controls.btnPrimary}
          onClick={() => void runPlanner()}
          disabled={busy !== null || !spec || !project}
        >
          {busy === 'planning' ? t('runSpec.planning') : t('runSpec.plan')}
        </button>
      )}
    </>
  )

  return (
    <Modal open={open} onClose={close} title={t('runSpec.title')} width={680} footer={footer}>
      <p className={styles.lede}>{t('runSpec.lede')}</p>
      {projects.length === 0 ? (
        <p className={controls.fieldError}>{t('runSpec.noProject')}</p>
      ) : (
        <label className={controls.field}>
          <span className={controls.label}>{t('runSpec.project')}</span>
          <select
            className={controls.input}
            value={projectId}
            disabled={busy !== null}
            onChange={(event) => {
              setProjectId(event.currentTarget.value)
              setPlan(null)
            }}
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={controls.field}>
        <span className={controls.label}>{t('runSpec.specLabel')}</span>
        <textarea
          className={`${controls.input} ${styles.spec}`}
          value={text}
          placeholder={t('runSpec.specPlaceholder')}
          aria-label={t('runSpec.specLabel')}
          disabled={busy !== null}
          onChange={(event) => {
            setText(event.currentTarget.value)
            setPlan(null)
          }}
        />
        <div className={styles.attachRow}>
          <button
            type="button"
            className={controls.btnSm}
            onClick={() => void attach()}
            disabled={busy !== null}
          >
            <Paperclip size={14} />
            {t('runSpec.attach')}
          </button>
          {attachment ? (
            <span className={styles.attachment}>
              <FileText size={14} />
              <span className={styles.attachmentName}>
                {t('runSpec.attached', { name: attachment.name })}
              </span>
              <button
                type="button"
                className={controls.iconBtnSm}
                onClick={() => {
                  setAttachment(null)
                  setPlan(null)
                }}
                disabled={busy !== null}
                title={t('runSpec.clearAttachment')}
                aria-label={t('runSpec.clearAttachment')}
              >
                <X size={14} />
              </button>
            </span>
          ) : null}
        </div>
      </div>
      {error ? <p className={controls.fieldError}>{error}</p> : null}
      {plan ? (
        <section className={styles.preview} aria-label={t('runSpec.tasksHeading', { count: launchable })}>
          <header className={styles.previewHeader}>
            <strong>{t('runSpec.tasksHeading', { count: launchable })}</strong>
            <span className={styles.source}>
              {plan.source === 'gemini' ? t('runSpec.planSourceGemini') : t('runSpec.planSourceHeuristic')}
            </span>
          </header>
          {plan.notice ? <p className={styles.notice}>{t(NOTICE_KEYS[plan.notice])}</p> : null}
          {plan.tasks.length === 0 ? <p className={styles.notice}>{t('runSpec.noTasks')}</p> : null}
          <ul className={styles.tasks}>
            {plan.tasks.map((task) => (
              <li key={task.id} className={styles.task}>
                <div className={styles.taskHead}>
                  <span className={styles.taskId}>{task.id}</span>
                  <span className={styles.taskTitle} title={task.prompt}>
                    {task.title}
                  </span>
                  <span className={styles.kind}>{t(KIND_KEYS[task.kind])}</span>
                  <button
                    type="button"
                    className={controls.iconBtnSm}
                    onClick={() => removeTask(task.id)}
                    disabled={busy !== null}
                    title={t('runSpec.removeTask')}
                    aria-label={t('runSpec.removeTask')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className={styles.taskMeta}>
                  <span className={styles.files}>
                    {t('runSpec.taskFiles')}:{' '}
                    {task.files.length > 0 ? task.files.join(', ') : t('runSpec.wholeRepo')}
                  </span>
                  {task.dependsOn.length > 0 ? (
                    <span className={styles.deps}>
                      {t('runSpec.taskDeps', { deps: task.dependsOn.join(', ') })}
                    </span>
                  ) : null}
                </div>
                {task.agent === 'shell' ? (
                  <div className={styles.shellRow}>
                    <Terminal size={14} />
                    <code className={styles.command}>{task.command ?? t('runSpec.shellTask')}</code>
                  </div>
                ) : (
                  <label className={styles.cliRow}>
                    <span className={controls.label}>{t('runSpec.taskCli')}</span>
                    <select
                      className={`${controls.input} ${styles.cliSelect}`}
                      value={task.agent}
                      disabled={busy !== null}
                      onChange={(event) =>
                        updateTask(task.id, { agent: event.currentTarget.value as AgentType })
                      }
                    >
                      {plan.agents.map((agent) => (
                        <option key={agent} value={agent}>
                          {AGENT_TYPE_LABELS[agent]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Modal>
  )
}
