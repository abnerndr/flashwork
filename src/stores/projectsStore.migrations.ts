   
                                                                                
                                                                                    
                                                                      
   

import { nanoid } from 'nanoid'

import { normalizeEnabledFeatures } from '../lib/features'
import { wslDistroFromPath } from '../lib/wsl'
import {
  type AppliedVsxTheme,
  DEFAULT_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  type Group,
  GROUP_COLORS,
  type GridLayout,
  type Preferences,
  type Project,
  type ProjectsFile,
  REMOVED_PANE_KINDS,
  type Terminal,
  type WorkspaceContainer,
  type WorkspaceRecentTab,
  type WorkspaceTab,
  type WorkspaceViewSnapshot,
} from '../lib/types'
import {
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  MAX_WORKSPACE_TABS,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import {
  clampSpawnConcurrency,
  clampUiZoom,
  MAX_RECENT_PROJECT_TABS,
} from './projectsStore.constants'

type LegacyPreferences = Partial<Preferences> & {
  showGitControl?: boolean
  omniRouteEnabled?: boolean
  omniRouteBaseUrl?: string
  omniRouteCaveman?: boolean
}

/**
 * P15: preference keys of removed features (Spotify, Discord presence, remote control, gist
 * sync, Flows, Todos, dictation, Ghostty renderer, GSD sync). Stripped on every load.
 */
export const REMOVED_PREFERENCE_KEYS = [
  'spotifyClientId',
  'spotifyClientSecret',
  'discordRichPresenceEnabled',
  'topbarShowSync',
  'remoteEnabled',
  'remoteMaxDevices',
  'remoteSessionExpirySecs',
  'remoteReadOnly',
  'remoteAllowShellInput',
  'flowsAllowLoopback',
  'todoStoragePath',
  'dictationEnabled',
  'nativeTerminalMacos',
  'gsdSyncModelChain',
] as const

/** P15: per-pane fields of removed features (browser pane, GSD sync viewer, remote control). */
const REMOVED_TERMINAL_FIELDS = ['url', 'browserConfig', 'gsdSyncViewer', 'remoteExcluded'] as const

function normalizeStoredAccent(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback
}

function normalizeStoredAccents(file: ProjectsFile): ProjectsFile {
  const normalizeTab = (tab: WorkspaceTab): WorkspaceTab => ({
    ...tab,
    color: normalizeStoredAccent(tab.color),
  })

  return {
    ...file,
    groups: file.groups.map((group) => ({
      ...group,
      color: normalizeStoredAccent(group.color, GROUP_COLORS[0])!,
    })),
    projects: file.projects.map((project) => ({
      ...project,
      color: normalizeStoredAccent(project.color),
    })),
    workspace: {
      ...file.workspace,
      tabs: file.workspace.tabs.map(normalizeTab),
      closedTabs: file.workspace.closedTabs?.map(normalizeTab),
    },
  }
}

function normalizeAppliedVsxTheme(raw: unknown): AppliedVsxTheme | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<AppliedVsxTheme>
  const extensionId = typeof value.extensionId === 'string' ? value.extensionId.trim() : ''
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  const uiTheme = typeof value.uiTheme === 'string' ? value.uiTheme.trim() : 'vs-dark'
  if (!extensionId || !path) return null
  return { extensionId, path, label: label || extensionId, uiTheme: uiTheme || 'vs-dark' }
}

export function normalizePreferences(raw: LegacyPreferences | undefined): Preferences {
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...(raw ?? {}),
  } as Preferences & LegacyPreferences
  delete preferences.showGitControl
  delete preferences.omniRouteEnabled
  delete preferences.omniRouteBaseUrl
  delete preferences.omniRouteCaveman
  const record = preferences as unknown as Record<string, unknown>
  for (const key of REMOVED_PREFERENCE_KEYS) delete record[key]
  const rawResourcePolicy = raw?.resourcePolicy
  const resourcePolicy = {
    ...DEFAULT_PREFERENCES.resourcePolicy,
    ...(rawResourcePolicy ?? {}),
  }
  const memoryBudgetMb = Math.min(8192, Math.max(768, Math.round(resourcePolicy.memoryBudgetMb)))
  const warningThresholdMb = Math.min(
    memoryBudgetMb - 64,
    Math.max(512, Math.round(resourcePolicy.warningThresholdMb)),
  )
  const recoveryTargetMb = Math.min(
    warningThresholdMb - 64,
    Math.max(384, Math.round(resourcePolicy.recoveryTargetMb)),
  )
  const legacyAccountCreated =
    raw?.accountCreated ??
    Boolean(raw?.onboardingDone && raw?.displayName && raw.displayName.trim().length > 0)
  const rawWindowOpacity = Number(raw?.windowOpacity ?? 1)
  return {
    ...preferences,
    wslEnabled: raw?.wslEnabled === true,
    wslDefaultDistro: typeof raw?.wslDefaultDistro === 'string' ? raw.wslDefaultDistro : '',
    wslEnvironmentPinned: raw?.wslEnvironmentPinned === true,
    windowOpacity: Number.isFinite(rawWindowOpacity)
      ? Math.min(1, Math.max(0.6, rawWindowOpacity))
      : 1,
                                                                               
                                                                            
    enabledAgents: { ...DEFAULT_PREFERENCES.enabledAgents, ...preferences.enabledAgents },
                                                                                 
    enabledFeatures: normalizeEnabledFeatures(raw),
    leftSidebarVisible: raw?.leftSidebarVisible ?? true,
    rightSidebarVisible: raw?.rightSidebarVisible ?? true,
    leftSidebarWidth: Math.min(380, Math.max(220, Math.round(raw?.leftSidebarWidth ?? 286))),
    rightSidebarWidth: Math.min(420, Math.max(260, Math.round(raw?.rightSidebarWidth ?? 300))),
    language: preferences.language === 'pt-BR' ? 'pt-BR' : 'en',
    visualStyle: raw?.visualStyle === 'clean' ? 'clean' : 'normal',
    accountCreated: legacyAccountCreated,
    topbarStyle: preferences.topbarStyle === 'three-areas' ? 'three-areas' : 'classic',
    gitControlPlacement: preferences.gitControlPlacement === 'right' ? 'right' : 'left',
    mcpDefaultScope: preferences.mcpDefaultScope === 'project' ? 'project' : 'global',
    mcpOnboardingSeen: Boolean(preferences.mcpOnboardingSeen),
    showTokenHud: Boolean(preferences.showTokenHud),
    appliedVsxTheme: normalizeAppliedVsxTheme(raw?.appliedVsxTheme),
    displayName: preferences.displayName.trim(),
    profileImageUrl: preferences.profileImageUrl.trim(),
    uiZoom: clampUiZoom(preferences.uiZoom),
    spawnConcurrency: clampSpawnConcurrency(preferences.spawnConcurrency),
    resourcePolicy: {
      // Automatic parking was removed. Keep the legacy shape for file
      // compatibility, but normalize every installation to monitoring only.
      mode: 'manual',
      automaticParkingOptIn: false,
      memoryBudgetMb,
      warningThresholdMb,
      recoveryTargetMb,
      hiddenAgentIdleMinutes: Math.min(
        240,
        Math.max(5, Math.round(resourcePolicy.hiddenAgentIdleMinutes)),
      ),
      hiddenShellIdleMinutes: Math.min(
        480,
        Math.max(5, Math.round(resourcePolicy.hiddenShellIdleMinutes)),
      ),
      spawnGraceSeconds: Math.min(900, Math.max(30, Math.round(resourcePolicy.spawnGraceSeconds))),
    },
  }
}

export function migrateWorkspaceNavigation(base: {
  workspace?: any
  projects: Project[]
  groups: Group[]
  activeProjectId: string | null
  preferences: Preferences
}) {
  const rawWorkspace = base.workspace ?? {}
  const containers = rawWorkspace.containers ?? []
  const currentSnapshot = sanitizeWorkspaceSnapshot(
    captureWorkspaceSnapshot({
      containers,
      activeProjectId: base.activeProjectId,
      activeGroupId: rawWorkspace.activeGroupId ?? null,
      focusedTerminalId: rawWorkspace.focusedTerminalId ?? null,
      preferences: base.preferences,
    }),
    base.projects,
  )

  if (Array.isArray(rawWorkspace.tabs)) {
    const tabs: WorkspaceTab[] = rawWorkspace.tabs
      .slice(0, MAX_WORKSPACE_TABS)
      .map((tab: WorkspaceTab) => ({
        ...tab,
        snapshot: sanitizeWorkspaceSnapshot(tab.snapshot ?? currentSnapshot, base.projects),
      }))
    const tabIds = new Set(tabs.map((tab) => tab.id))
    const history = (rawWorkspace.history ?? [])
      .filter((entry: any) => entry?.snapshot)
      .map((entry: any) => ({
        ...entry,
        snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, base.projects),
      }))
      .slice(-50)
    return {
      ...rawWorkspace,
      containers: currentSnapshot.containers,
      tabs,
      closedTabs: Array.isArray(rawWorkspace.closedTabs)
        ? rawWorkspace.closedTabs
            .map((tab: WorkspaceTab) => ({
              ...tab,
              snapshot: sanitizeWorkspaceSnapshot(tab.snapshot ?? currentSnapshot, base.projects),
            }))
            .slice(0, MAX_WORKSPACE_TABS)
        : [],
      activeTabId: tabIds.has(rawWorkspace.activeTabId)
        ? rawWorkspace.activeTabId
        : (tabs[0]?.id ?? null),
      activeGroupId: rawWorkspace.activeGroupId ?? null,
      focusedTerminalId: rawWorkspace.focusedTerminalId ?? null,
      history,
      historyIndex: Math.min(rawWorkspace.historyIndex ?? history.length - 1, history.length - 1),
    }
  }

  const recentTabs: WorkspaceRecentTab[] =
    rawWorkspace.recentTabs ??
    (rawWorkspace.recentProjectIds ?? []).map((id: string) => ({ kind: 'project', id }))
  const now = Date.now()
  const tabs = recentTabs
    .map<WorkspaceTab | null>((recent, index) => {
      if (recent.kind === 'group') {
        const group = base.groups.find((item) => item.id === recent.id)
        if (!group) return null
        return {
          id: nanoid(),
          kind: 'group' as const,
          sourceId: group.id,
          label: group.name,
          color: group.color,
          iconUrl: group.iconUrl,
          snapshot: cloneWorkspaceSnapshot(currentSnapshot),
          createdAt: now + index,
          updatedAt: now + index,
        }
      }
      const project = base.projects.find((item) => item.id === recent.id)
      if (!project) return null
      const container = containers.find((item: WorkspaceContainer) => item.projectId === project.id)
      const snapshot = container
        ? {
            ...cloneWorkspaceSnapshot(currentSnapshot),
            containers: [{ ...container, paneIds: [...container.paneIds] }],
            activeProjectId: project.id,
            activeGroupId: null,
          }
        : currentSnapshot
      return {
        id: nanoid(),
        kind: 'project' as const,
        sourceId: project.id,
        label: project.name,
        color: project.color,
        iconUrl: project.iconUrl,
        snapshot,
        createdAt: now + index,
        updatedAt: now + index,
      }
    })
    .filter((tab): tab is WorkspaceTab => tab !== null)
    .slice(0, MAX_WORKSPACE_TABS)
  const activeTab = tabs.find((tab) => tab.sourceId === base.activeProjectId) ?? tabs[0] ?? null
  const history = activeTab
    ? [
        {
          id: nanoid(),
          tabId: activeTab.id,
          label: activeTab.label,
          snapshot: cloneWorkspaceSnapshot(currentSnapshot),
          visitedAt: now,
        },
      ]
    : []
  return {
    ...rawWorkspace,
    containers: currentSnapshot.containers,
    recentProjectIds: (rawWorkspace.recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS),
    recentTabs: recentTabs.slice(0, MAX_RECENT_PROJECT_TABS),
    tabs,
    closedTabs: [],
    activeTabId: activeTab?.id ?? null,
    activeGroupId: activeTab?.snapshot.activeGroupId ?? null,
    focusedTerminalId: activeTab?.snapshot.focusedTerminalId ?? null,
    history,
    historyIndex: history.length - 1,
  }
}

function migrateToV7(parsed: any): ProjectsFile {
  return normalizeStoredAccents({
    ...parsed,
    version: 7,
    projects: (parsed.projects ?? []).map((project: any) => {
      // Backfill: a project stored under a WSL UNC path belongs to that distro.
      const wslDistro = project.wslDistro ?? wslDistroFromPath(project.defaultCwd)
      return {
        ...project,
        gridLayoutHistory: project.gridLayoutHistory ?? [],
        ...(wslDistro ? { wslDistro } : {}),
      }
    }),
    groups: (parsed.groups ?? []).map((group: any) => ({
      ...group,
      gridLayoutHistory: group.gridLayoutHistory ?? [],
    })),
    preferences: {
      ...normalizePreferences(parsed.preferences),
      workspaceGridLayoutHistory: parsed.preferences?.workspaceGridLayoutHistory ?? [],
    },
  })
}

function dropPaneIdsFromLayout<T extends GridLayout | undefined>(layout: T, paneIds: Set<string>): T {
  if (!layout?.cells || paneIds.size === 0) return layout
  const cells = { ...layout.cells }
  let changed = false
  for (const id of paneIds) {
    if (id in cells) {
      delete cells[id]
      changed = true
    }
  }
  return changed ? { ...layout, cells } : layout
}

/** True for panes whose feature no longer exists (P13 editor, P15 browser/video/GSD sync). */
function isRemovedPane(term: Terminal): boolean {
  const legacy = term as Terminal & { gsdSyncViewer?: unknown }
  return (term.kind != null && REMOVED_PANE_KINDS.includes(term.kind)) || Boolean(legacy.gsdSyncViewer)
}

function stripRemovedTerminalFields(term: Terminal): Terminal {
  if (!REMOVED_TERMINAL_FIELDS.some((field) => field in term)) return term
  const next = { ...term } as Record<string, unknown>
  for (const field of REMOVED_TERMINAL_FIELDS) delete next[field]
  return next as Terminal
}

/**
 * Drops persisted state of removed features: panes of removed kinds (P13 Monaco editor,
 * P15 web/browser, video, GSD sync viewer) with every layout reference to them, the Open VSX
 * theme, the Agent Sandbox project mode, the per-project Graphify switch (always on now),
 * removed per-pane fields and the global Todos list.
 */
export function dropRemovedFeatures(file: ProjectsFile): ProjectsFile {
  const removedIds = new Set<string>()
  for (const project of file.projects) {
    for (const term of project.terminals ?? []) {
      if (isRemovedPane(term)) removedIds.add(term.id)
    }
  }

  const stripPaneIds = (ids: string[]) => ids.filter((id) => !removedIds.has(id))
  const stripContainers = (containers: WorkspaceContainer[]) =>
    containers.map((container) => ({
      ...container,
      paneIds: stripPaneIds(container.paneIds),
    }))
  const stripSnapshot = (snapshot: WorkspaceViewSnapshot): WorkspaceViewSnapshot => ({
    ...snapshot,
    containers: stripContainers(snapshot.containers ?? []),
    focusedTerminalId:
      snapshot.focusedTerminalId && removedIds.has(snapshot.focusedTerminalId)
        ? null
        : snapshot.focusedTerminalId,
    workspaceGridLayout: dropPaneIdsFromLayout(snapshot.workspaceGridLayout, removedIds),
  })
  const stripTabs = (tabs: WorkspaceTab[] | undefined) =>
    tabs?.map((tab) => (tab.snapshot ? { ...tab, snapshot: stripSnapshot(tab.snapshot) } : tab))

  const { todos: _legacyTodos, ...rest } = file as ProjectsFile & { todos?: unknown }
  const preferences = file.preferences
  return {
    ...rest,
    preferences: {
      ...preferences,
      appliedVsxTheme: null,
      workspaceGridLayout: dropPaneIdsFromLayout(preferences.workspaceGridLayout, removedIds),
      isolatedPaneId:
        preferences.isolatedPaneId && removedIds.has(preferences.isolatedPaneId)
          ? null
          : preferences.isolatedPaneId,
    },
    groups: file.groups.map((group) =>
      group.gridLayout
        ? { ...group, gridLayout: dropPaneIdsFromLayout(group.gridLayout, removedIds) }
        : group,
    ),
    projects: file.projects.map((project) => {
      // `graphifyEnabled`: Graphify is always on for every project folder now.
      const {
        mode: _legacyMode,
        graphifyEnabled: _legacyGraphifyEnabled,
        ...kept
      } = project as Project & { mode?: unknown; graphifyEnabled?: unknown }
      return {
        ...kept,
        terminals: (project.terminals ?? [])
          .filter((term) => !removedIds.has(term.id))
          .map(stripRemovedTerminalFields),
        gridLayout: dropPaneIdsFromLayout(project.gridLayout, removedIds),
        ...(project.paneGroups
          ? {
              paneGroups: project.paneGroups
                .map((group) => ({ ...group, paneIds: stripPaneIds(group.paneIds) }))
                .filter((group) => group.paneIds.length > 0),
            }
          : {}),
      }
    }),
    workspace: {
      ...file.workspace,
      containers: stripContainers(file.workspace.containers),
      focusedTerminalId:
        file.workspace.focusedTerminalId && removedIds.has(file.workspace.focusedTerminalId)
          ? null
          : file.workspace.focusedTerminalId,
      tabs: stripTabs(file.workspace.tabs) ?? [],
      closedTabs: stripTabs(file.workspace.closedTabs),
      history: (file.workspace.history ?? []).map((entry) =>
        entry.snapshot ? { ...entry, snapshot: stripSnapshot(entry.snapshot) } : entry,
      ),
    },
  }
}

/** Migrates older files and normalizes restorable snapshots. */
export function migrate(parsed: any): ProjectsFile {
  if (parsed.version === 7) return dropRemovedFeatures(migrateToV7(parsed))
  if (parsed.version === 6) return dropRemovedFeatures(migrateToV7(parsed))

  const v5Result = parsed.version === 5 ? parsed : migrateToV5(parsed)

  // Migrate v5 -> v6: track worktrees whose cleanup did not finish.
  const v6Projects = (v5Result.projects ?? []).map((p: any) => ({
    ...p,
    orphanWorktrees: p.orphanWorktrees ?? [],
  }))

  return dropRemovedFeatures(
    migrateToV7({
      ...v5Result,
      version: 6,
      projects: v6Projects,
      preferences: normalizePreferences(v5Result.preferences),
    }),
  )
}

function migrateToV5(parsed: any): any {
  let v4Result: any
  if (parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
    // backfill parentGroupId (v2.1) — grupos antigos viram raiz.
    const groups = (parsed.groups ?? []).map((g: any) => ({
      ...g,
      parentGroupId: g.parentGroupId ?? null,
    }))
    const preferences = normalizePreferences(parsed.preferences)
    const base = {
      ...EMPTY_PROJECTS_FILE,
      ...parsed,
      version: 6 as const,
      preferences,
      groups,
      ungroupedOrder: parsed.ungroupedOrder ?? [],
    }
    v4Result = {
      ...base,
      workspace: migrateWorkspaceNavigation({
        workspace: parsed.workspace,
        projects: base.projects,
        groups,
        activeProjectId: base.activeProjectId,
        preferences,
      }),
    }
  } else {
    // legacy v1 -> v4
    const oldProjects: any[] = parsed.projects ?? []
    const projects: Project[] = oldProjects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      groupId: null,
      terminals: p.terminals ?? [],
      layoutMode: p.layoutMode ?? 'auto',
      collapsed: p.collapsed ?? false,
      createdAt: p.createdAt ?? Date.now(),
    }))

    const containers: WorkspaceContainer[] = oldProjects
      .filter((p) => Array.isArray(p.activeTerminalIds) && p.activeTerminalIds.length > 0)
      .map((p) => ({
        projectId: p.id,
        paneIds: p.activeTerminalIds,
        size: 0,
        internalLayout: p.layoutMode ?? 'auto',
        collapsed: false,
      }))

    v4Result = {
      version: 4,
      groups: [],
      ungroupedOrder: projects.map((p) => p.id),
      projects,
      activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
      workspace: migrateWorkspaceNavigation({
        workspace: {
          containers,
          recentProjectIds: containers.map((c) => c.projectId).slice(0, MAX_RECENT_PROJECT_TABS),
          recentTabs: containers
            .map((c) => ({ kind: 'project' as const, id: c.projectId }))
            .slice(0, MAX_RECENT_PROJECT_TABS),
        },
        projects,
        groups: [],
        activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
        preferences: normalizePreferences(parsed.preferences),
      }),
      preferences: normalizePreferences(parsed.preferences),
      cliPaths: parsed.cliPaths ?? {},
    }
  }

  // Migrate v4 -> v5
  const projects = (v4Result.projects ?? []).map((p: any) => ({
    ...p,
    worktreeMode: p.worktreeMode ?? 'gitWorktree',
    validationCommands: p.validationCommands ?? [],
    gsdWatcherEnabled: p.gsdWatcherEnabled ?? false,
    conflictAgentProvider: p.conflictAgentProvider ?? 'claude',
  }))

  return {
    ...v4Result,
    version: 5,
    projects,
  }
}

                                                                              
export function collectGroupProjectIds(groupId: string, groups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const g = groups.find((gr) => gr.id === cur)
    if (!g) continue
    for (const pid of g.projectIds) result.add(pid)
    for (const sg of groups) {
      if (sg.parentGroupId === cur) queue.push(sg.id)
    }
  }
  return result
}
