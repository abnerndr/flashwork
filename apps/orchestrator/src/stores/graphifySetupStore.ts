import { create } from 'zustand'

import { translate, type MessageKey } from '../lib/i18n'
import {
  graphifyEnsureGraph,
  graphifyInstall,
  graphifyStatus,
  type GraphifyInstallStatus,
} from '../lib/tauri'
import { wslDistroFromPath } from '../lib/wsl'
import { useProjectsStore } from './projectsStore'
import { useUiStore } from './uiStore'

/**
 * Graphify install state, shared by the project header CTA, the graph pane and the project
 * bootstrap. Graphify is installed per environment: the host, or each WSL distro a project
 * lives in, so state is keyed by that scope.
 */
export function graphifyScope(folder: string): string {
  const distro = wslDistroFromPath(folder)
  return distro ? `wsl:${distro}` : 'native'
}

type GraphifySetupState = {
  statusByScope: Record<string, GraphifyInstallStatus | undefined>
  installingScope: string | null
  /** Scopes already told that Graphify is missing during this app session. */
  promptedScopes: Record<string, true | undefined>

  check: (folder: string, force?: boolean) => Promise<GraphifyInstallStatus | null>
  install: (folder: string) => Promise<boolean>
  notifyMissing: (folder: string) => void
}

const inflight = new Map<string, Promise<GraphifyInstallStatus | null>>()

function tr(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useProjectsStore.getState().preferences.language, key, params)
}

export const useGraphifySetupStore = create<GraphifySetupState>((set, get) => ({
  statusByScope: {},
  installingScope: null,
  promptedScopes: {},

  check: async (folder, force = false) => {
    const scope = graphifyScope(folder)
    const cached = get().statusByScope[scope]
    if (cached && !force) return cached
    const pending = inflight.get(scope)
    if (pending && !force) return pending
    const request = graphifyStatus(folder)
      .then((status) => {
        set((s) => ({ statusByScope: { ...s.statusByScope, [scope]: status } }))
        return status
      })
      .catch(() => null)
      .finally(() => inflight.delete(scope))
    inflight.set(scope, request)
    return request
  },

  install: async (folder) => {
    const scope = graphifyScope(folder)
    if (get().installingScope) return false
    set({ installingScope: scope })
    const toast = useUiStore.getState().pushToast
    toast({ title: tr('graphify.installing'), body: tr('graphify.installingBody') })
    try {
      const result = await graphifyInstall(folder)
      set((s) => ({ statusByScope: { ...s.statusByScope, [scope]: result.status } }))
      if (result.ok) {
        toast({
          title: tr('graphify.installed'),
          body: tr('graphify.installedBody', { installer: result.installer ?? '—' }),
        })
        void graphifyEnsureGraph(folder).catch(() => undefined)
        return true
      }
      const lastLine = result.output.trim().split('\n').pop() ?? ''
      toast({ title: tr('graphify.installFailed'), body: lastLine || tr('graphify.noInstaller') })
      return false
    } catch (error) {
      const message = String(error)
      toast({
        title: tr('graphify.installFailed'),
        body: message.includes('no_installer') ? tr('graphify.noInstaller') : message,
      })
      return false
    } finally {
      set({ installingScope: null })
    }
  },

  notifyMissing: (folder) => {
    const scope = graphifyScope(folder)
    if (get().promptedScopes[scope]) return
    set((s) => ({ promptedScopes: { ...s.promptedScopes, [scope]: true } }))
    useUiStore.getState().pushToast({
      title: tr('graphify.missingTitle'),
      body: tr('graphify.missingBody'),
    })
  },
}))
