import { X } from 'lucide-react'

import { useT } from '../../lib/i18n'
import styles from './EditorPane.module.css'

export type EditorTab = {
  rel: string
  name: string
  dirty: boolean
}

type EditorTabsProps = {
  tabs: EditorTab[]
  activeRel: string | null
  onSelect: (rel: string) => void
  onClose: (rel: string) => void
}

export function EditorTabs({ tabs, activeRel, onSelect, onClose }: EditorTabsProps) {
  const t = useT()
  if (tabs.length === 0) return <div className={styles.tabs} />
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('editor.tabs')}>
      {tabs.map((tab) => {
        const active = tab.rel === activeRel
        return (
          <div
            key={tab.rel}
            className={`${styles.tab} ${active ? styles.tabActive : ''}`}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(tab.rel)}
          >
            <button
              type="button"
              className={styles.tabName}
              onClick={() => onSelect(tab.rel)}
              title={tab.rel}
            >
              {tab.dirty ? (
                <span className={styles.dirtyDot} title={t('editor.dirty')} aria-label={t('editor.dirty')} />
              ) : null}
              {tab.name}
            </button>
            <button
              type="button"
              className={styles.closeTab}
              aria-label={t('editor.closeTab')}
              title={t('editor.closeTab')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.rel)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
