import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  cliShimInstall,
  type CliShimStatus,
  cliShimStatus,
  cliShimUninstall,
} from '../../../lib/tauri'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

function TerminalCommandSection() {
  const t = useT()
  const [status, setStatus] = useState<CliShimStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void cliShimStatus()
      .then((next) => {
        if (!disposed) setStatus(next)
      })
      .catch(() => {
        if (!disposed) setStatus(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  const run = async (action: () => Promise<CliShimStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="terminal-command"
      title={t('prefs.cliCommand')}
      description={t('prefs.cliCommandDesc')}
    >
      <div className={styles.integrationFields}>
        <pre className={styles.cliUsage}>
          <code>{'flashwork\nflashwork .\nflashwork ~/meu-projeto'}</code>
        </pre>

        {status?.supported === false ? (
          <p>{t('prefs.cliUnsupported')}</p>
        ) : (
          <>
            <div className={styles.cliActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={busy || !status}
                onClick={() => void run(cliShimInstall)}
              >
                {status?.installed ? t('prefs.cliReinstall') : t('prefs.cliInstall')}
              </button>
              {status?.installed ? (
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnDanger}`}
                  disabled={busy}
                  onClick={() => void run(cliShimUninstall)}
                >
                  {t('prefs.cliUninstall')}
                </button>
              ) : null}
            </div>

            {status?.installed && status.path ? (
              <p className={styles.cliPath}>{t('prefs.cliInstalledAt', { path: status.path })}</p>
            ) : null}

            {status?.stale ? <p className={styles.cliWarning}>{t('prefs.cliStale')}</p> : null}

            {status?.installed && !status.onPath && status.binDir ? (
              <p className={styles.cliWarning}>{t('prefs.cliNotOnPath', { dir: status.binDir })}</p>
            ) : null}

            {error ? <p className={styles.cliWarning}>{error}</p> : null}
          </>
        )}
      </div>
    </SettingsSection>
  )
}

export function IntegrationsPage() {
  return <TerminalCommandSection />
}
