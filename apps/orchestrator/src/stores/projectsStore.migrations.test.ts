import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences } from './projectsStore.migrations'

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
})
