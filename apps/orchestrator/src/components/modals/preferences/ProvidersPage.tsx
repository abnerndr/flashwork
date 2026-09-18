import { useEffect, useState } from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  applyCatalogRefresh,
  getCatalogRefreshedAt,
  markCatalogRefreshed,
} from '../../../lib/providers/catalogOverlay'
import type { ProviderId } from '../../../lib/providers/modelCatalog'
import {
  providerCatalogRefresh,
  providerKeyClear,
  providerKeySet,
  providerKeyStatus,
} from '../../../lib/tauri'
import type { Preferences } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

type CliToggleKey = 'useAnthropicKeyOnCli' | 'useOpenaiKeyOnCli' | 'useGoogleKeyOnCli'

type ProviderRowConfig = {
  id: ProviderId
  titleKey: MessageKey
  cliToggleKey: CliToggleKey
}

const PROVIDER_ROWS: ProviderRowConfig[] = [
  { id: 'anthropic', titleKey: 'providers.anthropicTitle', cliToggleKey: 'useAnthropicKeyOnCli' },
  { id: 'openai', titleKey: 'providers.openaiTitle', cliToggleKey: 'useOpenaiKeyOnCli' },
  { id: 'google', titleKey: 'providers.googleTitle', cliToggleKey: 'useGoogleKeyOnCli' },
]

function ProviderRow({ config }: { config: ProviderRowConfig }) {
  const t = useT()
  const useKeyOnCli = useProjectsStore((state) => state.preferences[config.cliToggleKey])
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = () => {
    void providerKeyStatus(config.id)
      .then((status) => setSaved(status.saved))
      .catch(() => setSaved(false))
  }

  useEffect(() => {
    refreshStatus()
    // Only re-check when the provider id changes; refreshStatus is re-created each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id])

  const handleSave = async () => {
    setError(null)
    setBusy(true)
    try {
      await providerKeySet(config.id, key)
      setKey('')
      refreshStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setError(null)
    setBusy(true)
    try {
      await providerKeyClear(config.id)
      refreshStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.providerRow}>
      <div className={styles.providerRowHeader}>
        <strong>{t(config.titleKey)}</strong>
        <span className={`${styles.providerStatus} ${saved ? styles.providerStatusSaved : ''}`}>
          {saved ? t('providers.statusSaved') : t('providers.statusEmpty')}
        </span>
      </div>

      <div className={controls.inputActionRow}>
        <input
          className={controls.input}
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={t('providers.keyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={busy || key.trim().length === 0}
          onClick={() => void handleSave()}
        >
          {t('providers.save')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnDanger}`}
          disabled={busy || !saved}
          onClick={() => void handleClear()}
        >
          {t('providers.clear')}
        </button>
      </div>

      <label className={controls.checkboxRow}>
        <input
          type="checkbox"
          checked={useKeyOnCli}
          onChange={(event) =>
            setPreferences({
              [config.cliToggleKey]: event.target.checked,
            } as Partial<Preferences>)
          }
        />
        <span className={controls.checkboxLabel}>{t('providers.useOnCli')}</span>
      </label>

      {error ? <p className={styles.providerError}>{error}</p> : null}
    </div>
  )
}

function CatalogRefreshRow() {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(() => getCatalogRefreshedAt())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'success' | 'error' | null>(null)

  const handleRefresh = async () => {
    setBusy(true)
    setResult(null)
    try {
      const refreshed = await providerCatalogRefresh()
      const producedOverlay = Object.values(refreshed).some(
        (models) => Array.isArray(models) && models.length > 0,
      )
      if (!producedOverlay) {
        // Every provider failed (or returned no models): keep the existing snapshot
        // and leave the timestamp untouched — nothing was actually refreshed.
        setResult('error')
        return
      }
      applyCatalogRefresh(refreshed)
      markCatalogRefreshed()
      setRefreshedAt(getCatalogRefreshedAt())
      setResult('success')
    } catch {
      // Total failure: keep the existing snapshot untouched, per the locked contract.
      setResult('error')
    } finally {
      setBusy(false)
    }
  }

  const refreshedLabel = refreshedAt
    ? t('providers.refreshedAt', { time: new Date(refreshedAt).toLocaleString(locale) })
    : t('providers.refreshNever')

  return (
    <div className={styles.providerRow}>
      <div className={controls.inputActionRow}>
        <button
          type="button"
          className={controls.btn}
          disabled={busy}
          onClick={() => void handleRefresh()}
        >
          {busy ? t('providers.refreshing') : t('providers.refresh')}
        </button>
        <span className={styles.providerStatus}>{refreshedLabel}</span>
      </div>
      {result === 'success' ? <p className={styles.providerRowHeader}>{t('providers.refreshSuccess')}</p> : null}
      {result === 'error' ? <p className={styles.providerError}>{t('providers.refreshError')}</p> : null}
    </div>
  )
}

export function ProvidersPage() {
  const t = useT()
  return (
    <SettingsSection
      id="providers"
      title={t('providers.title')}
      description={t('providers.description')}
    >
      <div className={styles.providerList}>
        <CatalogRefreshRow />
        {PROVIDER_ROWS.map((config) => (
          <ProviderRow key={config.id} config={config} />
        ))}
      </div>
    </SettingsSection>
  )
}
