import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences, REMOVED_PREFERENCE_KEYS } from './projectsStore.migrations'

describe('preference normalization', () => {
  it('preserves persisted sidebar visibility and widths', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })

    expect(preferences).toMatchObject({
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })
  })

  it('disables legacy automatic parking preferences', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      resourcePolicy: {
        ...DEFAULT_PREFERENCES.resourcePolicy,
        mode: 'smart-lru',
        automaticParkingOptIn: true,
      },
    })

    expect(preferences.resourcePolicy).toMatchObject({
      mode: 'manual',
      automaticParkingOptIn: false,
    })
  })

  it('strips legacy OmniRoute preference keys', () => {
    const preferences = normalizePreferences({
      omniRouteEnabled: true,
      omniRouteBaseUrl: 'http://127.0.0.1:20128',
      omniRouteCaveman: true,
    })

    expect(preferences).not.toHaveProperty('omniRouteEnabled')
    expect(preferences).not.toHaveProperty('omniRouteBaseUrl')
    expect(preferences).not.toHaveProperty('omniRouteCaveman')
  })

  it('defaults showTokenHud to false when the key is missing', () => {
    const preferences = normalizePreferences({})

    expect(preferences.showTokenHud).toBe(false)
  })

  it('preserves an explicit showTokenHud true', () => {
    const preferences = normalizePreferences({ showTokenHud: true })

    expect(preferences.showTokenHud).toBe(true)
  })
})

describe('projects file migration', () => {
  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, workspaceGridLayoutHistory: undefined },
    })

    expect(migrated.version).toBe(7)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })

  it('backfills wslDistro from a WSL project path', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        { id: 'wsl', terminals: [], defaultCwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\p' },
        { id: 'win', terminals: [], defaultCwd: 'C:\\code\\p' },
        { id: 'kept', terminals: [], defaultCwd: 'C:\\x', wslDistro: 'Debian' },
      ],
    })

    expect(migrated.projects[0].wslDistro).toBe('Ubuntu')
    expect(migrated.projects[1]).not.toHaveProperty('wslDistro')
    expect(migrated.projects[2].wslDistro).toBe('Debian')
  })

  it('drops persisted editor panes and Open VSX theme', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      preferences: {
        ...DEFAULT_PREFERENCES,
        appliedVsxTheme: {
          extensionId: 'pub.theme',
          path: 'themes/dark.json',
          label: 'Dark',
          uiTheme: 'vs-dark',
        },
      },
      projects: [
        {
          id: 'project',
          terminals: [
            {
              id: 'editor-pane',
              kind: 'editor',
              name: 'Editor',
              cwd: '/repo',
              tabs: [],
              activeTabId: '',
              disabled: false,
              laneVisible: null,
              lastUsedAt: 1,
            },
            {
              id: 'shell-pane',
              kind: 'terminal',
              name: 'Shell',
              cwd: '/repo',
              tabs: [],
              activeTabId: '',
              disabled: false,
              laneVisible: null,
              lastUsedAt: 1,
            },
          ],
        },
      ],
      workspace: {
        ...EMPTY_PROJECTS_FILE.workspace,
        containers: [
          {
            projectId: 'project',
            paneIds: ['editor-pane', 'shell-pane'],
            size: 0,
            internalLayout: 'auto',
            collapsed: false,
          },
        ],
      },
    })

    expect(migrated.projects[0].terminals.map((term) => term.id)).toEqual(['shell-pane'])
    expect(migrated.workspace.containers[0].paneIds).toEqual(['shell-pane'])
    expect(migrated.preferences.appliedVsxTheme).toBeNull()
  })

  it('drops panes, fields and preferences of features removed in P15', () => {
    const pane = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      cwd: '/repo',
      tabs: [],
      activeTabId: '',
      disabled: false,
      laneVisible: null,
      ...extra,
    })
    const legacyPreferences = {
      ...DEFAULT_PREFERENCES,
      spotifyClientId: 'id',
      spotifyClientSecret: 'secret',
      discordRichPresenceEnabled: true,
      topbarShowSync: true,
      remoteEnabled: true,
      remoteMaxDevices: 2,
      remoteSessionExpirySecs: 3600,
      remoteReadOnly: true,
      remoteAllowShellInput: false,
      flowsAllowLoopback: true,
      todoStoragePath: '/todos',
      dictationEnabled: true,
      nativeTerminalMacos: true,
      gsdSyncModelChain: ['a'],
      isolatedPaneId: 'web-pane',
      enabledFeatures: {
        ...DEFAULT_PREFERENCES.enabledFeatures,
        todos: true,
        browser: true,
        aiMemory: true,
        canvasFlows: true,
      },
      workspaceGridLayout: {
        cols: 2,
        rows: 1,
        cells: {
          'web-pane': { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
          'shell-pane': { col: 1, row: 0, colSpan: 1, rowSpan: 1 },
        },
      },
    }
    const containers = [
      {
        projectId: 'project',
        paneIds: ['web-pane', 'video-pane', 'gsd-pane', 'shell-pane'],
        size: 0,
        internalLayout: 'auto',
        collapsed: false,
      },
    ]

    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      todos: [{ id: 'todo', title: 'Old todo', completed: false, tags: [] }],
      preferences: legacyPreferences,
      projects: [
        {
          id: 'project',
          mode: 'agentSandbox',
          paneGroups: [{ id: 'group', paneIds: ['web-pane', 'video-pane'] }],
          gridLayout: {
            cols: 1,
            rows: 2,
            cells: {
              'video-pane': { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
              'shell-pane': { col: 0, row: 1, colSpan: 1, rowSpan: 1 },
            },
          },
          terminals: [
            pane('web-pane', { kind: 'web', url: 'https://example.com', browserConfig: {} }),
            pane('video-pane', { kind: 'video', filePath: '/repo/clip.mp4' }),
            pane('gsd-pane', { gsdSyncViewer: true }),
            pane('shell-pane', { kind: 'terminal', remoteExcluded: true }),
          ],
        },
      ],
      workspace: {
        ...EMPTY_PROJECTS_FILE.workspace,
        containers,
        focusedTerminalId: 'video-pane',
        tabs: [
          {
            id: 'tab',
            kind: 'project',
            label: 'Project',
            createdAt: 1,
            updatedAt: 1,
            snapshot: {
              containers,
              activeProjectId: 'project',
              activeGroupId: null,
              focusedTerminalId: 'web-pane',
              workspaceFlat: false,
              fullscreenContainerId: null,
            },
          },
        ],
      },
    })

    const project = migrated.projects[0]
    expect(project.terminals.map((term) => term.id)).toEqual(['shell-pane'])
    expect(project.terminals[0]).not.toHaveProperty('remoteExcluded')
    expect(project).not.toHaveProperty('mode')
    expect(project.paneGroups).toEqual([])
    expect(Object.keys(project.gridLayout?.cells ?? {})).toEqual(['shell-pane'])
    expect(migrated.workspace.containers[0].paneIds).toEqual(['shell-pane'])
    expect(migrated.workspace.focusedTerminalId).toBeNull()
    expect(migrated.workspace.tabs[0].snapshot.containers[0].paneIds).toEqual(['shell-pane'])
    expect(migrated.workspace.tabs[0].snapshot.focusedTerminalId).toBeNull()
    expect(migrated).not.toHaveProperty('todos')

    const preferences = migrated.preferences
    for (const key of REMOVED_PREFERENCE_KEYS) expect(preferences).not.toHaveProperty(key)
    expect(Object.keys(preferences.enabledFeatures).sort()).toEqual(['git', 'mcp'])
    expect(preferences.isolatedPaneId).toBeNull()
    expect(Object.keys(preferences.workspaceGridLayout?.cells ?? {})).toEqual(['shell-pane'])
  })

  it('keeps kept pane kinds and is idempotent', () => {
    const file = {
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        {
          id: 'project',
          terminals: ['terminal', 'markdown', 'file', 'image', 'graphify', 'diff'].map((kind) => ({
            id: `${kind}-pane`,
            kind,
            name: kind,
            cwd: '/repo',
            tabs: [],
            activeTabId: '',
            disabled: false,
            laneVisible: null,
          })),
        },
      ],
    }

    const once = migrate(file)
    const twice = migrate(JSON.parse(JSON.stringify(once)))

    expect(once.projects[0].terminals).toHaveLength(6)
    expect(twice).toEqual(once)
  })
})

describe('Graphify always-on migration', () => {
  const graphifyProject = (graphifyEnabled: boolean) => ({
    id: `project-${graphifyEnabled}`,
    name: 'Project',
    defaultCwd: '/repo',
    graphifyEnabled,
    terminals: [],
  })

  it('drops the per-project switch and the global feature id from a v7 file', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      preferences: {
        ...DEFAULT_PREFERENCES,
        enabledFeatures: { git: true, graphify: true, mcp: false },
      },
      projects: [graphifyProject(true), graphifyProject(false)],
    })

    for (const project of migrated.projects) {
      expect(project).not.toHaveProperty('graphifyEnabled')
      expect(project.defaultCwd).toBe('/repo')
    }
    expect(migrated.preferences.enabledFeatures).toEqual({ git: true, mcp: false })
  })

  it('drops them from legacy files too and is idempotent', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [graphifyProject(true)],
      preferences: { enabledFeatures: { graphify: false } },
    })
    expect(migrated.projects[0]).not.toHaveProperty('graphifyEnabled')
    expect(migrated.preferences.enabledFeatures).not.toHaveProperty('graphify')

    const again = migrate(JSON.parse(JSON.stringify(migrated)))
    expect(again.projects).toEqual(migrated.projects)
    expect(again.preferences.enabledFeatures).toEqual(migrated.preferences.enabledFeatures)
  })
})
