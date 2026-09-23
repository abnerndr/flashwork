import { useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { resumeInterruptedAuto } from '../../lib/promptRun/resumeInterruptedAuto'
import type { PromptRun } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './InterruptedResumeModal.module.css'

export function InterruptedResumeModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'interruptedResume')
  const closeModal = useUiStore((state) => state.closeModal)
  const contextRuns = useUiStore((state) => state.modalContext?.runs)
  const projects = useProjectsStore((state) => state.projects)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [items, setItems] = useState<PromptRun[]>([])

  const runs = useMemo(() => {
    if (items.length > 0) return items
    if (!Array.isArray(contextRuns)) return []
    return contextRuns as PromptRun[]
  }, [contextRuns, items])

  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? projectId

  const dismissAll = async () => {
    for (const run of runs) {
      await usePromptRunStore.getState().discardInterrupted(run.projectId, run.id)
    }
    setItems([])
    closeModal()
  }

  const discardOne = async (run: PromptRun) => {
    setBusyId(run.id)
    try {
      await usePromptRunStore.getState().discardInterrupted(run.projectId, run.id)
      setItems((current) => {
        const source = current.length > 0 ? current : runs
        const next = source.filter((item) => item.id !== run.id)
        if (next.length === 0) closeModal()
        return next
      })
    } finally {
      setBusyId(null)
    }
  }

  const resumeOne = async (run: PromptRun) => {
    setBusyId(run.id)
    try {
      const result = await resumeInterruptedAuto(run)
      if (!result.ok) {
        useUiStore.getState().pushToast({
          title: t('interruptedResume.failedTitle'),
          body: t('interruptedResume.failedBody'),
        })
        return
      }
      useUiStore.getState().pushToast({
        title: t('interruptedResume.resumedTitle'),
        body: t('interruptedResume.resumedBody'),
      })
      useUiStore.getState().setActiveView('workspace')
      setItems((current) => {
        const source = current.length > 0 ? current : runs
        const next = source.filter((item) => item.id !== run.id)
        if (next.length === 0) closeModal()
        return next
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      open={open && runs.length > 0}
      onClose={() => void dismissAll()}
      title={t('interruptedResume.title')}
      width={520}
      footer={
        <button type="button" className={controls.btn} onClick={() => void dismissAll()} disabled={busyId !== null}>
          {t('interruptedResume.dismissAll')}
        </button>
      }
    >
      <p className={styles.lede}>{t('interruptedResume.lede')}</p>
      <ul className={styles.list}>
        {runs.map((run) => (
          <li key={run.id} className={styles.row}>
            <div className={styles.meta}>
              <strong>{projectName(run.projectId)}</strong>
              <span className={styles.prompt}>{run.prompt}</span>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={controls.btnPrimary}
                disabled={busyId !== null}
                onClick={() => void resumeOne(run)}
              >
                {t('interruptedResume.resume')}
              </button>
              <button
                type="button"
                className={controls.btn}
                disabled={busyId !== null}
                onClick={() => void discardOne(run)}
              >
                {t('interruptedResume.discard')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
