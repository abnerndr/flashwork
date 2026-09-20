import { Puzzle, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  isExtensionIncompatible,
  isExtensionPathEscape,
} from '../../../lib/extensions'
import { useT } from '../../../lib/i18n'
import {
  extensionsInstall,
  extensionsList,
  extensionsUninstall,
  openvsxSearch,
  type InstalledExtension,
  type OpenVsxHit,
  type OpenVsxPage,
} from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import { EmptyState } from '../../EmptyState'
import controls from '../controls.module.css'
import styles from './ExtensionsBrowser.module.css'

type Props = {
  root: string | null
  layout?: 'panel' | 'modal'
  reloadToken?: number
}

function hitId(hit: OpenVsxHit): string {
  return `${hit.namespace}.${hit.name}`
}

export function ExtensionsBrowser({ root, layout = 'panel', reloadToken = 0 }: Props) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [term, setTerm] = useState('')
  const [page, setPage] = useState<OpenVsxPage | null>(null)
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [installed, setInstalled] = useState<InstalledExtension[]>([])
  const [pending, setPending] = useState<string | null>(null)

  const cwd = root?.trim() || null

  useEffect(() => {
    if (!cwd) {
      setInstalled([])
      return
    }
    let cancelled = false
    void extensionsList(cwd)
      .then((next) => {
        if (!cancelled) setInstalled(next)
      })
      .catch(() => {
        if (!cancelled) setInstalled([])
      })
    return () => {
      cancelled = true
    }
  }, [cwd, reloadToken])

  useEffect(() => {
    let cancelled = false
    setSearchState('loading')
    const timer = window.setTimeout(() => {
      void openvsxSearch(term.trim())
        .then((next) => {
          if (cancelled) return
          setPage(next)
          setSearchState('idle')
        })
        .catch(() => {
          if (cancelled) return
          setPage(null)
          setSearchState('error')
        })
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [term])

  const installedIds = useMemo(() => new Set(installed.map((item) => item.id)), [installed])

  const reportInstallError = (error: unknown) => {
    if (isExtensionIncompatible(error)) {
      pushToast({
        title: t('extensions.incompatibleTitle'),
        body: t('extensions.incompatibleBody'),
      })
      return
    }
    pushToast({
      title: t('extensions.installFailed'),
      body: isExtensionPathEscape(error)
        ? t('editor.errPathEscape')
        : t('extensions.errGeneric'),
    })
  }

  const install = async (hit: OpenVsxHit) => {
    if (!cwd) return
    const id = hitId(hit)
    setPending(id)
    try {
      const next = await extensionsInstall(cwd, hit.namespace, hit.name)
      setInstalled((current) => {
        const without = current.filter((item) => item.id !== next.id)
        return [...without, next].sort((left, right) => left.id.localeCompare(right.id))
      })
      pushToast({ title: t('extensions.installedOk', { name: next.displayName }), body: next.id })
    } catch (error) {
      reportInstallError(error)
    } finally {
      setPending(null)
    }
  }

  const uninstall = async (item: InstalledExtension) => {
    if (!cwd) return
    setPending(item.id)
    try {
      await extensionsUninstall(cwd, item.id)
      setInstalled((current) => current.filter((entry) => entry.id !== item.id))
      pushToast({ title: t('extensions.uninstalled', { name: item.displayName }), body: item.id })
    } catch {
      pushToast({
        title: t('extensions.uninstallFailed'),
        body: t('extensions.errGeneric'),
      })
    } finally {
      setPending(null)
    }
  }

  const results = page?.extensions ?? []

  return (
    <div className={`${styles.browser} ${layout === 'modal' ? styles.browserModal : ''}`}>
      <p className={styles.hint}>{t('extensions.hint')}</p>

      {!cwd ? (
        <div className={styles.empty}>
          <EmptyState compact icon={<Puzzle size={20} />} title={t('extensions.noProject')} />
        </div>
      ) : null}

      <div className={styles.search}>
        <Search size={16} />
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('extensions.search')}
          aria-label={t('extensions.search')}
        />
      </div>

      {page?.staleSince ? (
        <p className={styles.hint}>
          {t('extensions.stale', { date: new Date(page.staleSince).toLocaleDateString() })}
        </p>
      ) : null}

      {searchState === 'error' ? (
        <p className={styles.hint}>{t('extensions.offline')}</p>
      ) : searchState === 'loading' ? (
        <p className={styles.hint}>{t('extensions.loading')}</p>
      ) : (
        <p className={styles.hint}>{t('extensions.count', { count: results.length })}</p>
      )}

      <div className={styles.list}>
        {searchState === 'idle' && results.length === 0 ? (
          <p className={styles.hint}>{t('extensions.noResults')}</p>
        ) : null}
        {results.map((hit) => {
          const id = hitId(hit)
          const already = installedIds.has(id)
          return (
            <div key={id} className={styles.row}>
              <span className={styles.rowTop}>
                <span className={styles.name}>{hit.displayName || hit.name}</span>
                <span className={styles.id}>{id}</span>
                {hit.version ? <span className={styles.badge}>{hit.version}</span> : null}
                <span className={styles.actions}>
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm}`}
                    disabled={!cwd || pending !== null || already}
                    onClick={() => void install(hit)}
                  >
                    {pending === id
                      ? t('extensions.installing')
                      : already
                        ? t('extensions.installedBadge')
                        : t('extensions.install')}
                  </button>
                </span>
              </span>
              {hit.description ? <span className={styles.summary}>{hit.description}</span> : null}
            </div>
          )
        })}
      </div>

      <span className={styles.sectionTitle}>{t('extensions.installed')}</span>
      <div className={styles.list}>
        {installed.length === 0 ? (
          <p className={styles.hint}>{t('extensions.installedEmpty')}</p>
        ) : (
          installed.map((item) => (
            <div key={item.id} className={styles.row}>
              <span className={styles.rowTop}>
                <span className={styles.name}>{item.displayName || item.name}</span>
                <span className={styles.id}>{item.id}</span>
                {item.version ? <span className={styles.badge}>{item.version}</span> : null}
                <span className={styles.actions}>
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                    disabled={!cwd || pending !== null}
                    onClick={() => void uninstall(item)}
                    title={t('extensions.uninstall')}
                    aria-label={t('extensions.uninstall')}
                  >
                    <Trash2 size={16} />
                    {t('extensions.uninstall')}
                  </button>
                </span>
              </span>
              {item.description ? <span className={styles.summary}>{item.description}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
