import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { formatEta, specProgress } from '../../lib/promptRun/specProgress'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import styles from './SpecRunProgress.module.css'

export function SpecRunProgress() {
  const t = useT()
  const projectId = useProjectsStore((state) => state.activeProjectId)
  const run = usePromptRunStore((state) => (projectId ? state.byProjectId[projectId] : undefined))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!run?.specTasks || run.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [run?.id, run?.specTasks, run?.status])

  if (!run?.specTasks || run.status !== 'running') return null
  const progress = specProgress(run.specTasks, run.createdAt, now)
  const eta =
    progress.remaining === 0
      ? t('runSpec.progressDone')
      : progress.etaMs == null
        ? t('runSpec.progressEtaPending')
        : t('runSpec.progressEta', { time: formatEta(progress.etaMs) })

  return (
    <div className={styles.bar} role="status" aria-label={t('runSpec.progressLabel', { percent: progress.percent })}>
      <div className={styles.track} aria-hidden="true">
        <div className={styles.fill} style={{ width: `${progress.percent}%` }} />
      </div>
      <div className={styles.meta}>
        <strong>{t('runSpec.progressPercent', { percent: progress.percent })}</strong>
        <span className={styles.task} title={progress.currentTitle ?? ''}>
          {progress.currentTitle
            ? t('runSpec.progressTask', { title: progress.currentTitle })
            : t('runSpec.progressDone')}
        </span>
        <span>{t('runSpec.progressLeft', { count: progress.remaining, total: progress.total })}</span>
        <span>{eta}</span>
      </div>
    </div>
  )
}
