import { RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  checkOmniRouteHealth,
  OMNIROUTE_DEFAULT_BASE,
  type OmniRouteHealth,
} from '../../lib/flashwork/omniroute'
import styles from './RouterStatus.module.css'

export function RouterStatus() {
  const [health, setHealth] = useState<OmniRouteHealth | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async () => {
    setChecking(true)
    const next = await checkOmniRouteHealth()
    setHealth(next)
    setChecking(false)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const online = health?.ok === true

  return (
    <section className={styles.panel} aria-labelledby="flashwork-router-title">
      <header className={styles.header}>
        <div className={styles.identity}>
          <Route size={16} />
          <div>
            <h2 id="flashwork-router-title" className={styles.title}>
              OmniRoute
            </h2>
            <p className={styles.sub}>Optional local model gateway · {OMNIROUTE_DEFAULT_BASE}</p>
          </div>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void refresh()} disabled={checking}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </header>
      <div className={styles.status}>
        <span className={online ? styles.dotOn : styles.dotOff} />
        <strong>{online ? 'Connected' : 'Offline'}</strong>
        <span>{health?.detail ?? 'Checking…'}</span>
      </div>
      <p className={styles.hint}>
        Point agent CLIs at this gateway for multi-provider fallback. Settings stub — configure
        OmniRoute separately for now.
      </p>
    </section>
  )
}
