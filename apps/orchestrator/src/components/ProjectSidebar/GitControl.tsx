import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderSearch,
  GitBranch,
  GitPullRequest,
  Github,
  LayoutGrid,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { UiIcon } from '../ui/UiIcon'

import { useGitOrigin } from '../../hooks/useGitOrigin'
import { readableError } from '../../lib/errors'
import { createPullRequestUrl } from '../../lib/git/githubCompareUrl'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  getPtyCwd,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitFetch,
  type GitFileChange,
  gitInit,
  gitListBranches,
  gitPull,
  gitPush,
  gitRemoteAdd,
  type GitRepositoryStatus,
  gitStage,
  gitStatus,
  gitUnstage,
  githubRepoAuthStatus,
  looksLikeGitAuthError,
  openInBrowser,
  openInFileExplorer,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './GitControl.module.css'
import {
  SCM_GROUP_ORDER,
  scmMoreMenuEntries,
  type ScmGroupKind,
  type ScmMoreMenuItemId,
} from './scmLayout'

type GroupKind = ScmGroupKind

type GitControlProps = {
  projectId: string
  cwd: string
  ptyId: string | null
  terminalName: string
}

const ERROR_KEYS: Record<string, MessageKey> = {
  git_not_found: 'git.error.notFound',
  not_a_git_repository: 'git.error.notRepository',
  directory_not_found: 'git.error.directory',
}

export function GitControl({ projectId, cwd, ptyId, terminalName }: GitControlProps) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const openModal_ = useUiStore((state) => state.openModal_)
  const githubLoginOpen = useUiStore((state) => state.openModal === 'githubLogin')
  const [liveCwd, setLiveCwd] = useState(cwd)
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const requestId = useRef(0)
  // Focus bursts can retrigger git in a loop. Manual refresh (quiet=false) ignores the throttle.
  const lastAutoRefreshRef = useRef(0)

  useEffect(() => {
    setLiveCwd(cwd)
    if (cwd || !ptyId) return
    let cancelled = false
    getPtyCwd(ptyId)
      .then((value) => {
        if (!cancelled && value) setLiveCwd(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [cwd, ptyId])

  const refresh = useCallback(
    async (quiet = false) => {
      if (quiet) {
        const now = Date.now()
        if (now - lastAutoRefreshRef.current < 1500) return
        lastAutoRefreshRef.current = now
      }
      if (!liveCwd) {
        setStatus(null)
        setError('directory_not_found')
        setLoading(false)
        return
      }
      const id = ++requestId.current
      if (!quiet) setLoading(true)
      try {
        const next = await gitStatus(liveCwd)
        if (requestId.current !== id) return
        setStatus(next)
        setError(null)
      } catch (cause) {
        if (requestId.current !== id) return
        setStatus(null)
        setError(errorCode(cause))
      } finally {
        if (requestId.current === id) setLoading(false)
      }
    },
    [liveCwd],
  )

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 3000)
    const onFocus = () => void refresh(true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      requestId.current += 1
    }
  }, [refresh])

  const repoRoot = status?.repoRoot
  const currentBranch = status?.branch
  const { originUrl, originInput, setOriginInput, refreshOrigin } = useGitOrigin(
    projectId,
    repoRoot,
  )

  useEffect(() => {
    if (!repoRoot) {
      setBranches([])
      return
    }
    let cancelled = false
    void gitListBranches(repoRoot)
      .then((next) => {
        if (!cancelled) setBranches(next)
      })
      .catch(() => {
        if (!cancelled) setBranches([])
      })
    return () => {
      cancelled = true
    }
  }, [repoRoot, currentBranch])

  const refreshGithubAuth = useCallback(async () => {
    try {
      const next = await githubRepoAuthStatus()
      setGithubConnected(next.connected)
    } catch {
      setGithubConnected(false)
    }
  }, [])

  useEffect(() => {
    void refreshGithubAuth()
  }, [refreshGithubAuth, repoRoot])

  useEffect(() => {
    if (!githubLoginOpen) void refreshGithubAuth()
  }, [githubLoginOpen, refreshGithubAuth])

  const branchOptions = useMemo(() => {
    if (!currentBranch) return branches
    if (branches.includes(currentBranch)) return branches
    return [currentBranch, ...branches]
  }, [branches, currentBranch])

  const pullRequestUrl = createPullRequestUrl(originUrl, currentBranch)
  const canPublish = Boolean(originUrl) || originInput.trim().startsWith('https://')

  const run = async (action: () => Promise<unknown>, success?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (success) pushToast({ title: success, body: '' })
      await refresh(true)
    } catch (cause) {
      if (looksLikeGitAuthError(cause)) {
        const auth = await githubRepoAuthStatus().catch(() => null)
        setGithubConnected(auth?.connected ?? false)
        if (!auth?.connected) openModal_('githubLogin')
      }
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  const allStageable = useMemo(
    () =>
      status ? uniquePaths([...status.changes, ...status.untracked, ...status.conflicts]) : [],
    [status],
  )

  const commit = async () => {
    if (!status || !message.trim() || busy) return
    if (status.conflicts.length > 0) {
      pushToast({ title: t('git.error.conflicts'), body: '' })
      return
    }
    if (status.staged.length === 0) {
      if (allStageable.length === 0) return
      if (!window.confirm(t('git.confirm.stageAllCommit'))) return
    }
    await run(async () => {
      if (status.staged.length === 0) await gitStage(status.repoRoot, allStageable)
      await gitCommit(status.repoRoot, message.trim())
      setMessage('')
    }, t('git.commit.done'))
  }

  const pull = async () => {
    if (!status || busy || status.detached) return
    await run(() => gitPull(status.repoRoot), t('git.pull.done'))
  }

  const push = async () => {
    if (!status || busy || status.detached) return
    await run(() => gitPush(status.repoRoot), t('git.push.done'))
  }

  const publish = async () => {
    if (!status || busy || status.detached || !canPublish) return
    const publishRoot = status.repoRoot
    await run(async () => {
      if (!originUrl) {
        await gitRemoteAdd(publishRoot, 'origin', originInput)
        await refreshOrigin(publishRoot)
      }
      await gitPush(publishRoot)
    }, t('git.publish.done'))
  }

  const openPullRequest = () => {
    if (!pullRequestUrl || busy) return
    void openInBrowser(pullRequestUrl).catch((cause) => {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    })
  }

  const handleInitGit = async () => {
    if (!liveCwd || busy) return
    setBusy(true)
    try {
      await gitInit(liveCwd)
      pushToast({ title: t('git.initOffer.successTitle'), body: t('git.initOffer.successBody') })
      await refresh()
    } catch (cause) {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  if (!liveCwd) {
    return <GitMessage title={t('git.empty.noFolder')} description={t('git.empty.noFolderDesc')} />
  }

  if (loading && !status) {
    return <GitMessage title={t('git.loading')} />
  }

  if (error && !status) {
    const isNotRepo = error === 'not_a_git_repository'
    return (
      <GitMessage
        title={t(ERROR_KEYS[error] ?? 'git.error.generic')}
        description={
          isNotRepo
            ? t('git.initOffer.body')
            : error.startsWith('git_command_failed:')
              ? error.slice(error.indexOf(':') + 1)
              : undefined
        }
        action={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            {isNotRepo ? (
              <button
                type="button"
                className={`${styles.retry} ${styles.retryPrimary}`}
                style={{ width: '100%' }}
                disabled={busy}
                onClick={() => void handleInitGit()}
              >
                <UiIcon icon={GitBranch} />
                {busy ? t('git.initOffer.busy') : t('git.initOffer.button')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.retry}
              style={{ width: '100%' }}
              onClick={() => void refresh()}
            >
              <UiIcon icon={RefreshCw} />
              {t('git.refresh')}
            </button>
          </div>
        }
      />
    )
  }

  if (!status) return null
  const total =
    status.staged.length + status.changes.length + status.untracked.length + status.conflicts.length
  const syncTitle = t('git.sync.title', { ahead: status.ahead, behind: status.behind })
  const groupLabel: Record<GroupKind, string> = {
    staged: t('git.group.staged'),
    changes: t('git.group.changes'),
    untracked: t('git.group.untracked'),
    conflicts: t('git.group.conflicts'),
  }
  const moreItemSpec: Record<
    ScmMoreMenuItemId,
    Omit<Extract<MenuItem, { kind: 'item' }>, 'kind'>
  > = {
    fetch: {
      label: t('git.fetch.action'),
      icon: <UiIcon icon={Download} />,
      onClick: () => void run(() => gitFetch(status.repoRoot), t('git.fetch.done')),
    },
    pull: {
      label: t('git.pull.action'),
      icon: <UiIcon icon={ArrowDown} />,
      onClick: () => void pull(),
    },
    push: {
      label: t('git.push.action'),
      icon: <UiIcon icon={ArrowUp} />,
      onClick: () => void push(),
    },
    publish: {
      label: t('git.publish.action'),
      icon: <UiIcon icon={Upload} />,
      onClick: () => void publish(),
    },
    openPullRequest: {
      label: t('git.pullRequest.action'),
      icon: <UiIcon icon={GitPullRequest} />,
      onClick: openPullRequest,
    },
    signIn: {
      label: t('git.github.signIn'),
      icon: <UiIcon icon={Github} />,
      onClick: () => openModal_('githubLogin'),
    },
  }
  const moreMenuItems: MenuItem[] = scmMoreMenuEntries({
    showOpenPullRequest: Boolean(pullRequestUrl),
    showSignIn: githubConnected === false,
  }).map((entry) =>
    entry.kind === 'separator'
      ? { kind: 'separator' }
      : { kind: 'item', ...moreItemSpec[entry.id] },
  )

  return (
    <div className={styles.panel} aria-busy={busy}>
      <div className={styles.repoHeader} title={status.repoRoot}>
        <div className={styles.repoContext}>
          <strong>{terminalName}</strong>
          <span>{status.repoRoot}</span>
        </div>
        <UiIcon icon={GitBranch} />
        <select
          className={styles.branchSelect}
          value={status.branch}
          disabled={busy || status.conflicts.length > 0}
          aria-label={t('git.branch.label')}
          onChange={(event) => {
            const branch = event.target.value
            if (branch === status.branch) return
            void run(() => gitCheckout(status.repoRoot, branch))
          }}
        >
          {branchOptions.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        {status.detached ? <small>{t('git.detached')}</small> : null}
        <span className={styles.syncStatus} title={syncTitle} aria-label={syncTitle}>
          <span>
            <UiIcon icon={ArrowDown} />
            {status.behind}
          </span>
          <span>
            <UiIcon icon={ArrowUp} />
            {status.ahead}
          </span>
        </span>
        <div className={styles.headerActions}>
          {githubConnected === false ? (
            <button
              type="button"
              className={styles.signInButton}
              onClick={() => openModal_('githubLogin')}
              disabled={busy}
              title={t('git.github.signIn')}
              aria-label={t('git.github.signIn')}
            >
              <UiIcon icon={Github} />
              {t('git.github.signIn')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => void openInFileExplorer(status.repoRoot)}
            title={t('files.revealFolder')}
            aria-label={t('files.revealFolder')}
          >
            <UiIcon icon={FolderSearch} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => void refresh()}
            disabled={loading || busy}
            title={t('git.refresh')}
            aria-label={t('git.refresh')}
          >
            <UiIcon icon={RefreshCw} className={loading ? styles.spinning : undefined} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            disabled={busy}
            title={t('ui.sidebar.moreActions')}
            aria-label={t('ui.sidebar.moreActions')}
            aria-haspopup="menu"
            aria-expanded={moreMenu !== null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMoreMenu({ x: rect.right - 8, y: rect.bottom + 4 })
            }}
          >
            <UiIcon icon={MoreHorizontal} />
          </button>
        </div>
      </div>

      {moreMenu ? (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={moreMenuItems}
          onClose={() => setMoreMenu(null)}
        />
      ) : null}

      <div className={styles.commitBox}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
          }}
          placeholder={t('git.commit.placeholder')}
          aria-label={t('git.commit.placeholder')}
          rows={2}
        />
        <div className={styles.commitRow}>
          <button
            type="button"
            className={styles.commitButton}
            disabled={!message.trim() || busy || total === 0}
            onClick={() => void commit()}
          >
            <UiIcon icon={Check} />
            {busy ? t('git.commit.busy') : t('git.commit.action')}
          </button>
        </div>
      </div>

      {!originUrl ? (
        <div className={styles.originField}>
          <input
            className={styles.originInput}
            value={originInput}
            onChange={(event) => setOriginInput(event.target.value)}
            placeholder={t('git.origin.placeholder')}
            aria-label={t('git.origin.label')}
            disabled={busy}
          />
        </div>
      ) : null}

      <div className={styles.groups}>
        {SCM_GROUP_ORDER.map((kind) => (
          <ChangeGroup
            key={kind}
            projectId={projectId}
            repoRoot={status.repoRoot}
            kind={kind}
            label={groupLabel[kind]}
            items={status[kind]}
            disabled={busy}
            onPrimary={(paths) =>
              run(() => (kind === 'staged' ? gitUnstage : gitStage)(status.repoRoot, paths))
            }
            onDiscard={
              kind === 'changes'
                ? (paths) => run(() => gitDiscard(status.repoRoot, paths, false))
                : kind === 'untracked'
                  ? (paths) => run(() => gitDiscard(status.repoRoot, paths, true))
                  : undefined
            }
          />
        ))}
        {total === 0 ? (
          <div className={styles.clean}>
            <Check size={18} />
            <strong>{t('git.clean')}</strong>
            <span>{t('git.cleanDesc')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ChangeGroup({
  projectId,
  repoRoot,
  kind,
  label,
  items,
  disabled,
  onPrimary,
  onDiscard,
}: {
  projectId: string
  repoRoot: string
  kind: GroupKind
  label: string
  items: GitFileChange[]
  disabled: boolean
  onPrimary: (paths: string[]) => void
  onDiscard?: (paths: string[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const tree = useMemo(() => buildTree(items), [items])
  if (items.length === 0) return null
  const paths = uniquePaths(items)
  const primaryTitle = kind === 'staged' ? t('git.unstageAll') : t('git.stageAll')
  const confirmDiscard = (selected: string[]) => {
    if (onDiscard && window.confirm(t('git.confirm.discard', { count: selected.length })))
      onDiscard(selected)
  }
  return (
    <section className={styles.group}>
      <div className={styles.groupHeader}>
        <button
          type="button"
          className={styles.groupToggle}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <UiIcon icon={ChevronDown} /> : <UiIcon icon={ChevronRight} />}
          <strong>{label}</strong>
          <span>{items.length}</span>
        </button>
        <div className={styles.groupActions}>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discardAll')}
              aria-label={t('git.discardAll')}
              onClick={() => confirmDiscard(paths)}
            >
              <UiIcon icon={RotateCcw} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={primaryTitle}
            aria-label={primaryTitle}
            onClick={() => onPrimary(paths)}
          >
            {kind === 'staged' ? <UiIcon icon={Minus} /> : <UiIcon icon={Plus} />}
          </button>
        </div>
      </div>
      {open ? (
        <div className={styles.tree}>
          {tree.map((node) => (
            <TreeNodeView
              key={node.type === 'dir' ? `d:${node.path}` : `f:${node.change.path}`}
              projectId={projectId}
              repoRoot={repoRoot}
              node={node}
              kind={kind}
              depth={0}
              disabled={disabled}
              onPrimary={onPrimary}
              onDiscard={onDiscard ? confirmDiscard : undefined}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function TreeNodeView({
  projectId,
  repoRoot,
  node,
  kind,
  depth,
  disabled,
  onPrimary,
  onDiscard,
}: {
  projectId: string
  repoRoot: string
  node: TreeNode
  kind: GroupKind
  depth: number
  disabled: boolean
  onPrimary: (paths: string[]) => void
  onDiscard?: (paths: string[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const indent = { paddingLeft: 8 + depth * 12 }

  const createDiffPane = useProjectsStore((s) => s.createDiffPane)
  const createFilePane = useProjectsStore((s) => s.createFilePane)
  const openPane = useProjectsStore((s) => s.openPane)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)

  const handleDoubleClick = (filePath: string) => {
    if (kind === 'untracked') {
      openFile(filePath)
      return
    }
    const isStaged = kind === 'staged'
    const pane = createDiffPane(projectId, { filePath, repoRoot, staged: isStaged })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
  }

  const openFile = (filePath: string) => {
    const pane = createFilePane(projectId, { filePath: absoluteRepoPath(repoRoot, filePath) })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
  }

  if (node.type === 'file') {
    const change = node.change
    const isStaged = kind === 'staged'
    return (
      <div
        className={styles.file}
        style={indent}
        title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
        onDoubleClick={() => handleDoubleClick(change.path)}
      >
        <span className={styles.fileName}>{node.name}</span>
        <span className={`${styles.status} ${statusClass(kind, change.status)}`}>
          {statusChar(kind, change.status)}
        </span>
        <div className={styles.fileActions}>
          <button
            type="button"
            title={t('files.reveal')}
            aria-label={t('files.reveal')}
            onClick={() => void openInFileExplorer(absoluteRepoPath(repoRoot, change.path))}
          >
            <UiIcon icon={FolderSearch} />
          </button>
          <button
            type="button"
            title={t('files.addToGrid')}
            aria-label={t('files.addToGrid')}
            onClick={() => openFile(change.path)}
          >
            <UiIcon icon={LayoutGrid} />
          </button>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discard')}
              aria-label={t('git.discard')}
              onClick={() => onDiscard([change.path])}
            >
              <UiIcon icon={RotateCcw} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={isStaged ? t('git.unstage') : t('git.stage')}
            aria-label={isStaged ? t('git.unstage') : t('git.stage')}
            onClick={() => onPrimary([change.path])}
          >
            {isStaged ? <UiIcon icon={Minus} /> : <UiIcon icon={Plus} />}
          </button>
        </div>
      </div>
    )
  }

  const descendants = collectPaths(node)
  const isStaged = kind === 'staged'
  return (
    <>
      <div className={styles.dir} style={indent}>
        <button
          type="button"
          className={styles.dirToggle}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <UiIcon icon={ChevronDown} /> : <UiIcon icon={ChevronRight} />}
          <UiIcon icon={Folder} className={styles.dirIcon} />
          <span className={styles.dirName}>{node.name}</span>
        </button>
        <div className={styles.fileActions}>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discardAll')}
              aria-label={t('git.discardAll')}
              onClick={() => onDiscard(descendants)}
            >
              <UiIcon icon={RotateCcw} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={isStaged ? t('git.unstageAll') : t('git.stageAll')}
            aria-label={isStaged ? t('git.unstageAll') : t('git.stageAll')}
            onClick={() => onPrimary(descendants)}
          >
            {isStaged ? <UiIcon icon={Minus} /> : <UiIcon icon={Plus} />}
          </button>
        </div>
      </div>
      {open
        ? node.children.map((child) => (
            <TreeNodeView
              key={child.type === 'dir' ? `d:${child.path}` : `f:${child.change.path}`}
              projectId={projectId}
              repoRoot={repoRoot}
              node={child}
              kind={kind}
              depth={depth + 1}
              disabled={disabled}
              onPrimary={onPrimary}
              onDiscard={onDiscard}
            />
          ))
        : null}
    </>
  )
}

function GitMessage({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className={styles.message}>
      <GitBranch size={22} />
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  )
}

type DirNode = { type: 'dir'; name: string; path: string; children: TreeNode[] }
type FileNode = { type: 'file'; name: string; change: GitFileChange }
type TreeNode = DirNode | FileNode

function buildTree(items: GitFileChange[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] }
  for (const change of items) {
    const parts = change.path.split('/')
    const fileName = parts.pop() ?? change.path
    let cursor = root
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let next = cursor.children.find(
        (child): child is DirNode => child.type === 'dir' && child.name === part,
      )
      if (!next) {
        next = { type: 'dir', name: part, path: acc, children: [] }
        cursor.children.push(next)
      }
      cursor = next
    }
    cursor.children.push({ type: 'file', name: fileName, change })
  }
  return root.children.map(compress).sort(compareNodes)
}

function compress(node: TreeNode): TreeNode {
  if (node.type === 'file') return node
  let current = node
  while (current.children.length === 1 && current.children[0].type === 'dir') {
    const only = current.children[0]
    current = {
      type: 'dir',
      name: `${current.name}/${only.name}`,
      path: only.path,
      children: only.children,
    }
  }
  current.children = current.children.map(compress).sort(compareNodes)
  return current
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function collectPaths(node: TreeNode): string[] {
  if (node.type === 'file') return [node.change.path]
  return node.children.flatMap(collectPaths)
}

function statusClass(kind: GroupKind, status: string): string {
  if (kind === 'untracked') return styles.stAdded
  if (kind === 'conflicts') return styles.stConflict
  const code = (status.trim()[0] ?? '').toUpperCase()
  if (code === 'A') return styles.stAdded
  if (code === 'D') return styles.stDeleted
  if (code === 'R' || code === 'C') return styles.stRenamed
  if (code === 'M') return styles.stModified
  return styles.stOther
}

function statusChar(kind: GroupKind, status: string): string {
  if (kind === 'untracked') return 'U'
  if (kind === 'conflicts') return '!'
  return (status.trim()[0] ?? '•').toUpperCase()
}

function uniquePaths(items: GitFileChange[]): string[] {
  return [...new Set(items.map((item) => item.path))]
}

function errorCode(error: unknown): string {
  const value = String(error)
  return Object.keys(ERROR_KEYS).find((key) => value.includes(key)) ?? value
}

function absoluteRepoPath(repoRoot: string, relativePath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(relativePath)) return relativePath
  const separator = repoRoot.includes('\\') ? '\\' : '/'
  return `${repoRoot.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`
}
