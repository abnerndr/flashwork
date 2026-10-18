import { useEffect } from 'react'
import { UsageStrip } from '../HomeView/UsageStrip'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { getCachedGeminiUsage } from '../../lib/geminiUsageCache'
import { getCachedOpenCodeUsage } from '../../lib/opencodeUsageCache'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import styles from './AiUsageModal.module.css'

export function AiUsageModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'aiUsage')
  const closeModal = useUiStore((state) => state.closeModal)
  const setClaudeUsage = useUiStore((state) => state.setClaudeUsage)
  const setCodexUsage = useUiStore((state) => state.setCodexUsage)
  const setAntigravityUsage = useUiStore((state) => state.setAntigravityUsage)
  const setGeminiUsage = useUiStore((state) => state.setGeminiUsage)
  const setOpencodeUsage = useUiStore((state) => state.setOpencodeUsage)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.allSettled([
      getCachedClaudeUsage(true),
      getCachedCodexUsage(true),
      getCachedAntigravityUsage(true),
      getCachedGeminiUsage(true),
      getCachedOpenCodeUsage(true),
    ]).then(([claude, codex, antigravity, gemini, opencode]) => {
      if (cancelled) return
      setClaudeUsage(claude.status === 'fulfilled' ? claude.value : null)
      setCodexUsage(codex.status === 'fulfilled' ? codex.value : null)
      setAntigravityUsage(antigravity.status === 'fulfilled' ? antigravity.value : null)
      setGeminiUsage(gemini.status === 'fulfilled' ? gemini.value : null)
      setOpencodeUsage(opencode.status === 'fulfilled' ? opencode.value : null)
    })
    return () => {
      cancelled = true
    }
  }, [open, setAntigravityUsage, setClaudeUsage, setCodexUsage, setGeminiUsage, setOpencodeUsage])

  return (
    <Modal open={open} onClose={closeModal} title={t('usageModal.title')} width={920}>
      <p className={styles.description}>{t('usageModal.description')}</p>
      <UsageStrip showActivity={false} />
    </Modal>
  )
}
