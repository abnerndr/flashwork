import { useEffect, useId, useState } from 'react'

import { useT } from '../../lib/i18n'
import { isWindows } from '../../lib/platform'
import { wslStatus } from '../../lib/tauri'
import { preferredWslDistro } from '../../lib/wsl'
import controls from './controls.module.css'

export function WslEnvironmentField({
  value,
  onChange,
  hideLabel = false,
}: {
  value: string
  onChange: (distro: string) => void
  hideLabel?: boolean
}) {
  const t = useT()
  const labelId = useId()
  const [status, setStatus] = useState<{ distros: string[]; running: string[] } | null>(null)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!isWindows()) return
    let cancelled = false
    setStatus(null)
    setError(false)
    void wslStatus()
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])
  if (!isWindows()) return null

  const distros = status?.distros ?? []
  const wslOn = Boolean(value)
  const wslDisabled = !wslOn && (error || !status || distros.length === 0)
  const visibleDistros = Array.from(
    new Set(
      distros.filter(
        (distro) =>
          distro.toLowerCase() !== 'docker-desktop' &&
          distro.toLowerCase() !== 'docker-desktop-data',
      ),
    ),
  )
  const distroChoices = visibleDistros.length > 0 ? visibleDistros : distros
  const statusClass =
    error || (status && distros.length === 0)
      ? controls.statusBad
      : status?.running.length
        ? controls.statusActive
        : status
          ? controls.statusIdle
          : undefined
  const statusText = error
    ? t('wsl.unavailable')
    : !status
      ? t('wsl.checking')
      : status.running.length
        ? t('wsl.running', { distros: status.running.join(', ') })
        : status.distros.length
          ? t('wsl.stopped')
          : t('wsl.notInstalled')

  return (
    <div className={controls.field}>
      {hideLabel ? null : (
        <span className={controls.label} id={labelId}>
          {t('wsl.environment')}
        </span>
      )}
      <div
        className={controls.choiceRow}
        role="group"
        aria-label={hideLabel ? t('wsl.environment') : undefined}
        aria-labelledby={hideLabel ? undefined : labelId}
      >
        <button
          type="button"
          className={`${controls.choice} ${wslOn ? '' : controls.choiceActive}`}
          aria-pressed={!wslOn}
          onClick={() => onChange('')}
        >
          {t('wsl.powershell')}
        </button>
        <button
          type="button"
          className={`${controls.choice} ${wslOn ? controls.choiceActive : ''}`}
          aria-pressed={wslOn}
          disabled={wslDisabled}
          onClick={() => onChange(preferredWslDistro(distros, status?.running ?? [], value))}
        >
          {t('wsl.useWsl')}
        </button>
      </div>
      {wslOn && distroChoices.length > 1 ? (
        <div className={controls.choiceRow} role="group" aria-label={t('wsl.distroLabel')}>
          {distroChoices.map((distro) => (
            <button
              key={distro}
              type="button"
              className={`${controls.choice} ${distro === value ? controls.choiceActive : ''}`}
              aria-pressed={distro === value}
              onClick={() => onChange(distro)}
            >
              {distro}
            </button>
          ))}
        </div>
      ) : null}
      <span className={`${controls.hint} ${statusClass ?? ''}`} role="status">
        {statusText}
      </span>
      <button
        type="button"
        className={`${controls.btn} ${controls.btnSm}`}
        onClick={() => setRefresh((n) => n + 1)}
      >
        {t('wsl.refresh')}
      </button>
    </div>
  )
}
