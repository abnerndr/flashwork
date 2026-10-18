import { Copy, ExternalLink, Github, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  githubRepoDevicePoll,
  githubRepoDeviceStart,
  openInBrowser,
  writeClipboardText,
  type GithubDevicePollStatus,
  type GithubDeviceStart,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import styles from './GitHubLoginModal.module.css'

const FALLBACK_DEVICE_URI = 'https://github.com/login/device'

export function GitHubLoginModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'githubLogin')
  const closeModal = useUiStore((s) => s.closeModal)
  const pushToast = useUiStore((s) => s.pushToast)

  const [session, setSession] = useState<GithubDeviceStart | null>(null)
  const [pollStatus, setPollStatus] = useState<GithubDevicePollStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!open) {
      cancelledRef.current = true
      setSession(null)
      setPollStatus(null)
      setError(null)
      setCopied(false)
      setStarting(false)
      return
    }
    cancelledRef.current = false
    void startFlow()
    return () => {
      cancelledRef.current = true
    }
  }, [open])

  useEffect(() => {
    if (
      !open ||
      !session ||
      pollStatus === 'complete' ||
      pollStatus === 'denied' ||
      pollStatus === 'expired' ||
      pollStatus === 'error'
    ) {
      return
    }
    let cancelled = false
    let timeoutId = 0
    let intervalSec = Math.max(session.interval, 1)
    const tick = async () => {
      try {
        const result = await githubRepoDevicePoll(session.sessionId)
        if (cancelled || cancelledRef.current) return
        setPollStatus(result.status)
        if (result.status === 'complete') {
          pushToast({ title: t('git.github.signedIn'), body: '' })
          closeModal()
          return
        }
        if (result.status === 'error') {
          setError(t('git.github.pollError'))
          return
        }
        if (result.status === 'denied' || result.status === 'expired') {
          return
        }
        if (result.slowDown) {
          const bumped = intervalSec + 5
          intervalSec = Math.max(result.interval ?? 0, bumped)
        }
        timeoutId = window.setTimeout(() => void tick(), Math.max(intervalSec, 1) * 1000)
      } catch (cause) {
        if (cancelled || cancelledRef.current) return
        setPollStatus('error')
        setError(mapStartError(cause))
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [open, session, pollStatus, closeModal, pushToast, t])

  const startFlow = async () => {
    setStarting(true)
    setError(null)
    setPollStatus(null)
    setSession(null)
    try {
      const started = await githubRepoDeviceStart()
      if (cancelledRef.current) return
      setSession(started)
      setPollStatus('pending')
    } catch (cause) {
      if (cancelledRef.current) return
      setError(mapStartError(cause))
    } finally {
      if (!cancelledRef.current) setStarting(false)
    }
  }

  const mapStartError = (cause: unknown): string => {
    const raw = String((cause as { message?: string })?.message ?? cause)
    if (raw.includes('github_device_unconfigured')) return t('git.github.unconfigured')
    return t('git.github.error')
  }

  const onCopy = async () => {
    if (!session?.userCode) return
    try {
      await writeClipboardText(session.userCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const onOpenDevice = () => {
    const uri = session?.verificationUri?.trim() || FALLBACK_DEVICE_URI
    void openInBrowser(uri).catch(() => undefined)
  }

  const waiting = pollStatus === 'pending' || starting
  const failed =
    pollStatus === 'denied' || pollStatus === 'expired' || pollStatus === 'error' || Boolean(error)

  return (
    <Modal open={open} onClose={closeModal} title={t('git.github.title')} width={420}>
      <p className={styles.hint}>{t('git.github.hint')}</p>
      {session ? (
        <div className={styles.codeBlock}>
          <span className={styles.code}>{session.userCode}</span>
          <button type="button" className={styles.btn} onClick={() => void onCopy()}>
            <Copy size={14} />
            {copied ? t('git.github.copied') : t('git.github.copy')}
          </button>
        </div>
      ) : starting ? (
        <div className={styles.waiting}>
          <Loader2 size={16} className={styles.spin} />
          <span>{t('git.github.starting')}</span>
        </div>
      ) : null}
      {waiting && session ? (
        <div className={styles.waiting}>
          <Loader2 size={16} className={styles.spin} />
          <span>{t('git.github.waiting')}</span>
        </div>
      ) : null}
      {pollStatus === 'denied' ? <p className={styles.error}>{t('git.github.denied')}</p> : null}
      {pollStatus === 'expired' ? <p className={styles.error}>{t('git.github.expired')}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onOpenDevice}
          disabled={!session && starting}
        >
          <ExternalLink size={14} />
          {t('git.github.openDevice')}
        </button>
        {failed ? (
          <button type="button" className={styles.btn} onClick={() => void startFlow()}>
            <Github size={14} />
            {t('git.github.retry')}
          </button>
        ) : null}
      </div>
    </Modal>
  )
}
