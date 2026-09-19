import { Folder } from 'lucide-react'
import { useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { useT } from '../../../lib/i18n'
import { skillErrorKey } from '../../../lib/skills'
import { skillsInstall } from '../../../lib/tauri'
import { AGENT_TYPE_LABELS, MCP_AGENTS, type McpAgent } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { Modal } from '../Modal'
import styles from './SkillInstallFlow.module.css'

type Source = 'folder' | 'git'

type Props = {
  onClose: () => void
  onDone: () => void
}

export function SkillInstallFlow({ onClose, onDone }: Props) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)

  const [source, setSource] = useState<Source>('folder')
  const [folder, setFolder] = useState('')
  const [url, setUrl] = useState('')
  const [targets, setTargets] = useState<McpAgent[]>([...MCP_AGENTS])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)

  const canSubmit =
    !busy && (source === 'folder' ? folder.trim().length > 0 : url.trim().length > 0)

  const toggleTarget = (agent: McpAgent) =>
    setTargets((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    )

  const chooseFolder = async () => {
    const picked = await pickDirectory()
    if (picked) setFolder(picked)
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const summary = await skillsInstall({
        source:
          source === 'folder'
            ? { type: 'folder', path: folder.trim() }
            : { type: 'git', url: url.trim() },
        agents: targets,
        overwrite,
      })
      pushToast({
        title: t('skills.installed', { name: summary.name }),
        body: summary.path,
      })
      onDone()
      onClose()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      pushToast({ title: t('skills.installFailed'), body: t(skillErrorKey(raw)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      nested
      open
      onClose={onClose}
      title={t('skills.installTitle')}
      width={520}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {t('skills.installAction')}
          </button>
        </>
      }
    >
      <p className={styles.hint}>{t('skills.installHint')}</p>
      <div className={controls.tabRow} role="tablist">
        {(['folder', 'git'] as Source[]).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={source === option}
            className={`${controls.tabBtn} ${source === option ? controls.tabBtnActive : ''}`}
            onClick={() => setSource(option)}
          >
            {t(option === 'folder' ? 'skills.installFolder' : 'skills.installGit')}
          </button>
        ))}
      </div>

      <div className={styles.form}>
        {source === 'folder' ? (
          <div className={styles.field}>
            <span>{t('skills.installFolder')}</span>
            <div className={styles.folderRow}>
              <button type="button" className={controls.btn} onClick={() => void chooseFolder()}>
                <Folder size={13} />
                {t('skills.pickFolder')}
              </button>
              {folder ? (
                <span className={styles.folderPath} title={folder}>
                  {folder}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <label className={styles.field}>
            <span>{t('skills.gitUrl')}</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('skills.gitUrlPlaceholder')}
              aria-label={t('skills.gitUrl')}
            />
          </label>
        )}

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          {t('skills.overwrite')}
        </label>

        <div className={`${styles.field} ${styles.targetsBlock}`}>
          <span>{t('skills.fieldTargets')}</span>
          <p className={styles.hint}>{t('skills.fieldTargetsHint')}</p>
          <div className={styles.targets}>
            {MCP_AGENTS.map((agent) => (
              <label key={agent} className={styles.target}>
                <input
                  type="checkbox"
                  checked={targets.includes(agent)}
                  onChange={() => toggleTarget(agent)}
                />
                {AGENT_TYPE_LABELS[agent]}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
