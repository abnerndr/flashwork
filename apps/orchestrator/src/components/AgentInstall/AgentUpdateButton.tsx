import { ArrowUpCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useAgentInstall, useAgentOperationBusy } from '../../hooks/useAgentInstall'
import { type InstallToolchain, parentPath, updateMethodsFor } from '../../lib/agentInstall'
import { useT } from '../../lib/i18n'
import { openInFileExplorer, probeInstallToolchain } from '../../lib/tauri'
import type { AgentType } from '../../lib/types'
import { useUiStore } from '../../stores/uiStore'
import styles from './agentActions.module.css'

type Props = {
  agent: AgentType
  label: string
  onUpdated?: () => void
}

/**
 * Runs the first OS-aware update method (`updateMethodsFor`). Hidden when none exist so we
 * never fall back to a no-op npm command.
 */
export function AgentUpdateButton({ agent, label, onUpdated }: Props) {
  const t = useT()
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const { status, shadowConflict, install } = useAgentInstall(agent)
  const busyAgent = useAgentOperationBusy()
  const pushToast = useUiStore((s) => s.pushToast)
  const notifiedRef = useRef<'success' | 'failed' | null>(null)

  useEffect(() => {
    let cancelled = false
    void probeInstallToolchain()
      .then((result) => {
        if (!cancelled) setToolchain(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status === 'success') {
      if (notifiedRef.current === 'success') return
      notifiedRef.current = 'success'
      onUpdated?.()
    } else if (status === 'failed') {
      if (notifiedRef.current === 'failed') return
      notifiedRef.current = 'failed'
      pushToast({
        title: t('agentInstall.updateFailed'),
        body: shadowConflict
          ? t('agentInstall.updateFailedShadowed', { agent: label, path: shadowConflict.path })
          : t('agentInstall.updateFailedBody', { agent: label }),
        agent,
      })
    }
  }, [status, shadowConflict, onUpdated, pushToast, t, label, agent])

  const method = updateMethodsFor(agent, toolchain)[0]
  if (!method) return null

  const running = status === 'running'
  return (
    <>
      <button
        type="button"
        className={styles.quietBtn}
        disabled={running || (busyAgent !== null && busyAgent !== agent)}
        title={method.command}
        onClick={() => {
          notifiedRef.current = null
          void install(method)
        }}
      >
        <ArrowUpCircle size={13} />
        {running ? t('agentInstall.installing') : t('onboarding.agentUpdateAction')}
      </button>
      {shadowConflict ? (
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => {
            void openInFileExplorer(parentPath(shadowConflict.path)).catch(() => undefined)
          }}
        >
          {t('agentInstall.openInstallLocation')}
        </button>
      ) : null}
    </>
  )
}
