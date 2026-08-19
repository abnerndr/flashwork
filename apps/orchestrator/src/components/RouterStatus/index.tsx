import { Download, ExternalLink, RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useAgentOperationBusy, useCommandInstall } from '../../hooks/useCommandInstall'
import {
  type InstallToolchain,
  NODE_DOWNLOAD_URL,
  nodeInstallMethods,
} from '../../lib/agentInstall'
import {
  checkOmniRouteHealth,
  OMNIROUTE_DEFAULT_BASE,
  type OmniRouteHealth,
} from '../../lib/flashwork/omniroute'
import { sidecarInstallMethods } from '../../lib/flashwork/sidecarInstall'
import { useT } from '../../lib/i18n'
import {
  findCliLauncher,
  type OmniRouteStartResult,
  omnirouteGetGatewayKey,
  omnirouteSetGatewayKey,
  omnirouteStart,
  omnirouteStop,
  openInBrowser,
  probeInstallToolchain,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from '../modals/controls.module.css'
import {
  gatewayKeyPlaceholder,
  generateOmniRoutePassword,
  needsOmniRouteNode,
  normalizeOmniRouteBaseUrl,
  openOmniRouteDashboard,
  shouldShowPortBusy,
} from './routerStatusLogic'
import styles from './RouterStatus.module.css'

const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

export function RouterStatus() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const createWebPane = useProjectsStore((state) => state.createWebPane)
  const pushToast = useUiStore((state) => state.pushToast)

  const baseUrl = normalizeOmniRouteBaseUrl(
    preferences.omniRouteBaseUrl || OMNIROUTE_DEFAULT_BASE,
  )

  const [health, setHealth] = useState<OmniRouteHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [installed, setInstalled] = useState(false)
  const [password, setPassword] = useState('')
  const [draftKey, setDraftKey] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [startResult, setStartResult] = useState<OmniRouteStartResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  const install = useCommandInstall('9router', '9router')
  const nodeInstall = useCommandInstall('node-toolchain', 'npm')
  const busyAgent = useAgentOperationBusy()

  const refreshHealth = useCallback(async () => {
    setChecking(true)
    const next = await checkOmniRouteHealth(baseUrl)
    setHealth(next)
    setChecking(false)
    return next
  }, [baseUrl])

  const refreshInstallState = useCallback(async () => {
    const [nextToolchain, launcher] = await Promise.all([
      probeInstallToolchain().catch(() => null),
      findCliLauncher('9router').catch(() => null),
    ])
    setToolchain(nextToolchain)
    setInstalled(Boolean(launcher))
  }, [])

  useEffect(() => {
    void refreshHealth()
    const timer = window.setInterval(() => void refreshHealth(), 15_000)
    return () => window.clearInterval(timer)
  }, [refreshHealth])

  useEffect(() => {
    let disposed = false
    void refreshInstallState()
    void omnirouteGetGatewayKey()
      .then((key) => {
        if (!disposed) setHasStoredKey(Boolean(key))
      })
      .catch(() => {
        if (!disposed) setHasStoredKey(false)
      })
    return () => {
      disposed = true
    }
  }, [refreshInstallState])

  useEffect(() => {
    if (install.status === 'success') void refreshInstallState()
  }, [install.status, refreshInstallState])

  useEffect(() => {
    if (nodeInstall.status === 'success') void refreshInstallState()
  }, [nodeInstall.status, refreshInstallState])

  const online = health?.ok === true
  const methods = sidecarInstallMethods('9router', toolchain)
  const installMethod = methods[0]
  const missingNode = needsOmniRouteNode(toolchain, installed)
  const nodeMethod = missingNode ? nodeInstallMethods(toolchain)[0] : undefined
  const blockedByOther = (key: string) => busyAgent !== null && busyAgent !== key
  const installLog = install.log.replace(ANSI_PATTERN, '')
  const nodeLog = nodeInstall.log.replace(ANSI_PATTERN, '')
  const portBusy = shouldShowPortBusy(online, startResult?.alreadyRunning === true)

  const openDashboard = async () => {
    try {
      await openOmniRouteDashboard({
        baseUrl,
        projectId: activeProjectId,
        paneName: t('omni.title'),
        createWebPane,
        openInBrowser,
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleStart = async () => {
    setActionError(null)
    setStarting(true)
    const nextPassword = password || generateOmniRoutePassword()
    if (!password) setPassword(nextPassword)
    try {
      const result = await omnirouteStart(nextPassword, baseUrl)
      setStartResult(result)
      let next = await checkOmniRouteHealth(baseUrl)
      for (let attempt = 0; attempt < 8 && !next.ok; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        next = await checkOmniRouteHealth(baseUrl)
      }
      setHealth(next)
      if (next.ok) await openDashboard()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setActionError(null)
    setStopping(true)
    try {
      await omnirouteStop()
      setStartResult(null)
      await refreshHealth()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopping(false)
    }
  }

  const handleSaveKey = async () => {
    const key = draftKey.trim()
    if (!key) return
    setActionError(null)
    setSavingKey(true)
    try {
      await omnirouteSetGatewayKey(key)
      setDraftKey('')
      setHasStoredKey(true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="flashwork-router-title">
      <header className={styles.header}>
        <div className={styles.identity}>
          <Route size={16} />
          <div>
            <h2 id="flashwork-router-title" className={styles.title}>
              {t('omni.title')}
            </h2>
            <p className={styles.sub}>{t('omni.sub', { url: baseUrl })}</p>
          </div>
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refreshHealth()}
          disabled={checking}
        >
          <RefreshCw size={14} />
          {t('omni.refresh')}
        </button>
      </header>

      <div className={styles.status}>
        <span className={online ? styles.dotOn : styles.dotOff} />
        <strong>
          {checking && !health
            ? t('omni.checking')
            : online
              ? t('omni.connected')
              : t('omni.offline')}
        </strong>
        <span>
          {checking && !health ? t('omni.checking') : (health?.detail ?? t('omni.checking'))}
        </span>
      </div>

      <label className={controls.checkboxRow}>
        <input
          type="checkbox"
          checked={preferences.omniRouteEnabled}
          onChange={(event) => setPreferences({ omniRouteEnabled: event.target.checked })}
        />
        <span className={controls.checkboxLabel}>{t('omni.enable')}</span>
      </label>
      <p className={styles.hint}>{t('omni.enableHint')}</p>

      <label className={controls.checkboxRow}>
        <input
          type="checkbox"
          checked={preferences.omniRouteCaveman}
          onChange={(event) => {
            const enabled = event.target.checked
            setPreferences({ omniRouteCaveman: enabled })
            if (enabled) {
              pushToast({ title: t('omni.caveman'), body: t('omni.cavemanHint') })
            }
          }}
        />
        <span className={controls.checkboxLabel}>{t('omni.caveman')}</span>
      </label>
      <p className={styles.hint}>{t('omni.cavemanHint')}</p>

      <label className={styles.field}>
        <span>{t('omni.customUrl')}</span>
        <input
          className={controls.input}
          value={preferences.omniRouteBaseUrl || OMNIROUTE_DEFAULT_BASE}
          spellCheck={false}
          onChange={(event) =>
            setPreferences({
              omniRouteBaseUrl: event.target.value.replace(/localhost/gi, '127.0.0.1'),
            })
          }
          onBlur={(event) =>
            setPreferences({ omniRouteBaseUrl: normalizeOmniRouteBaseUrl(event.target.value) })
          }
        />
      </label>

      {missingNode ? (
        <div className={styles.box}>
          <p className={styles.hint}>{t('omni.needsNode')}</p>
          <div className={styles.actions}>
            {nodeMethod ? (
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={nodeInstall.status === 'running' || blockedByOther('node-toolchain')}
                onClick={() => void nodeInstall.install(nodeMethod)}
              >
                <Download size={13} />
                {nodeInstall.status === 'running'
                  ? t('agentInstall.installing')
                  : t('agentInstall.installNode')}
              </button>
            ) : null}
            <button
              type="button"
              className={controls.btn}
              onClick={() => void openInBrowser(NODE_DOWNLOAD_URL).catch(() => undefined)}
            >
              <ExternalLink size={13} />
              {t('agentInstall.downloadNode')}
            </button>
          </div>
          {nodeMethod ? <code className={styles.command}>{nodeMethod.command}</code> : null}
          {nodeLog.trim() ? <pre className={styles.log}>{nodeLog}</pre> : null}
        </div>
      ) : null}

      {!installed && installMethod ? (
        <div className={styles.box}>
          <p className={styles.hint}>{t('omni.installHint')}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={install.status === 'running' || blockedByOther('9router')}
              onClick={() => void install.install(installMethod)}
            >
              <Download size={13} />
              {install.status === 'running' ? t('agentInstall.installing') : t('omni.install')}
            </button>
          </div>
          <code className={styles.command}>{installMethod.command}</code>
          {install.status === 'failed' ? (
            <p className={styles.error}>{t('agentInstall.failed')}</p>
          ) : null}
          {installLog.trim() ? <pre className={styles.log}>{installLog}</pre> : null}
        </div>
      ) : null}

      {installed || online ? (
        <>
          <label className={styles.field}>
            <span>{t('omni.passwordLabel')}</span>
            <input
              className={controls.input}
              type="text"
              readOnly
              value={password}
              spellCheck={false}
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className={controls.btn}
              onClick={() => setPassword(generateOmniRoutePassword())}
            >
              {t('omni.generatePassword')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={starting}
              onClick={() => void handleStart()}
            >
              {t('omni.start')}
            </button>
            <button
              type="button"
              className={controls.btn}
              disabled={stopping}
              onClick={() => void handleStop()}
            >
              {t('omni.stop')}
            </button>
            {online ? (
              <button type="button" className={controls.btn} onClick={() => void openDashboard()}>
                {t('omni.openDashboard')}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {portBusy ? <p className={styles.warning}>{t('omni.portBusy')}</p> : null}

      <label className={styles.field}>
        <span>{t('omni.apiKeyLabel')}</span>
        <input
          className={controls.input}
          type="password"
          autoComplete="off"
          value={draftKey}
          placeholder={gatewayKeyPlaceholder(hasStoredKey)}
          spellCheck={false}
          onChange={(event) => setDraftKey(event.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={savingKey || !draftKey.trim()}
          onClick={() => void handleSaveKey()}
        >
          {t('omni.saveKey')}
        </button>
      </div>

      {actionError ? (
        <p className={styles.error}>{t('common.errorPrefix', { message: actionError })}</p>
      ) : null}
    </section>
  )
}
