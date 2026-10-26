import { FileText, Paperclip, Terminal, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { pickFiles } from '../../lib/dialog'
import { useT, type MessageKey } from '../../lib/i18n'
import { launchSpecRun, planSpec, usableSpecAgents, type SpecPlanNotice } from '../../lib/promptRun/runSpec'
import { joinSpecSources, MAX_SPEC_FILES } from '../../lib/promptRun/specSources'
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
  source: 'deepseek' | 'gemini' | 'heuristic'
  notice?: SpecPlanNotice
  spec: string
}

const SOURCE_KEYS: Record<Plan['source'], MessageKey> = {
  deepseek: 'runSpec.planSourceDeepseek',
  gemini: 'runSpec.planSourceGemini',
  heuristic: 'runSpec.planSourceHeuristic',
}

type Attachment = { path: string; name: string; content: string }

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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [workers, setWorkers] = useState<AgentType[] | null>(null)
  const [selectedWorkers, setSelectedWorkers] = useState<AgentType[]>([])
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

  useEffect(() => {
    if (!open || !cwd) {
      setWorkers(null)
      return
    }
    let cancel = false
    setWorkers(null)
    void usableSpecAgents(cwd).then((found) => {
      if (cancel) return
      setWorkers(found)
      setSelectedWorkers(found)
    })
    return () => {
      cancel = true
    }
  }, [open, cwd])
  const spec = useMemo(() => joinSpecSources(text, attachments), [attachments, text])
  const launchable = plan?.tasks.length ?? 0

  const close = () => {
    if (busy) return
    closeModal()
  }

  const attach = async () => {
    setError(null)
    const paths = await pickFiles({
      title: t('runSpec.attach'),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
    })
    if (!paths || paths.length === 0) return
    const room = MAX_SPEC_FILES - attachments.length
    const fresh = paths.filter((path) => !attachments.some((file) => file.path === path))
    if (room <= 0 || fresh.length > room) {
      setError(t('runSpec.tooMany', { count: MAX_SPEC_FILES }))
    }
    if (room <= 0) return
    const incoming = fresh.slice(0, room)
    const loaded: Attachment[] = []
    for (const path of incoming) {
      try {
        const content = await readSpecMarkdown(path)
        loaded.push({ path, name: fileName(path), content })
      } catch (cause) {
        setError(String(cause).includes('spec_too_large') ? t('runSpec.tooLarge') : t('runSpec.attachFailed'))
        break
      }
    }
    if (loaded.length === 0) return
    setAttachments((current) => [...current, ...loaded])
    setPlan(null)
  }

  const runPlanner = async () => {
    if (!project || !spec || busy) return
    setBusy('planning')
    setError(null)
    try {
      const result = await planSpec({ project, cwd, spec, allowedAgents: selectedWorkers })
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
      const result = await launchSpecRun({
        project,
        cwd,
        spec: plan.spec,
        tasks: plan.tasks,
        allowedAgents: selectedWorkers,
      })
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
      setAttachments([])
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
          className={`${controls.btn} ${controls.btnPrimary}`}
          onClick={() => void launch()}
          disabled={busy !== null || launchable === 0}
        >
          {busy === 'launching' ? t('runSpec.launching') : t('runSpec.launch', { count: launchable })}
        </button>
      ) : (
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          onClick={() => void runPlanner()}
          disabled={busy !== null || !spec || !project || selectedWorkers.length === 0}
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
        <span className={controls.label}>{t('runSpec.workersLabel')}</span>
        <p className={styles.workerHint}>{t('runSpec.workersHint')}</p>
        {workers === null ? (
          <p className={styles.workerHint}>{t('runSpec.workersLoading')}</p>
        ) : workers.length === 0 ? (
          <p className={styles.workerHint}>{t('runSpec.workersNone')}</p>
        ) : (
          <div className={styles.workerList}>
            {workers.map((agent) => (
              <label key={agent} className={controls.checkboxRow}>
                <input
                  type="checkbox"
                  checked={selectedWorkers.includes(agent)}
                  disabled={busy !== null}
                  onChange={() => {
                    setSelectedWorkers((current) =>
                      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
                    )
                    setPlan(null)
                  }}
                />
                <span className={controls.checkboxLabel}>{AGENT_TYPE_LABELS[agent]}</span>
              </label>
            ))}
          </div>
        )}
        {workers && workers.length > 0 && selectedWorkers.length === 0 ? (
          <p className={styles.workerHint}>{t('runSpec.workersEmpty')}</p>
        ) : null}
      </div>
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
          {attachments.map((file) => (
            <span key={file.path} className={styles.attachment}>
              <FileText size={14} />
              <span className={styles.attachmentName}>
                {t('runSpec.attached', { name: file.name })}
              </span>
              <button
                type="button"
                className={controls.iconBtnSm}
                onClick={() => {
                  setAttachments((current) => current.filter((item) => item.path !== file.path))
                  setPlan(null)
                }}
                disabled={busy !== null}
                title={t('runSpec.clearAttachment')}
                aria-label={t('runSpec.clearAttachment')}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
      </div>
      {error ? <p className={controls.fieldError}>{error}</p> : null}
      {plan ? (
        <section className={styles.preview} aria-label={t('runSpec.tasksHeading', { count: launchable })}>
          <header className={styles.previewHeader}>
            <strong>{t('runSpec.tasksHeading', { count: launchable })}</strong>
            <span className={styles.source}>
              {t(SOURCE_KEYS[plan.source])}
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
