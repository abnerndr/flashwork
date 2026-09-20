import { invoke } from '@tauri-apps/api/core'

export type OpenVsxHit = {
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
}

export type OpenVsxPage = {
  extensions: OpenVsxHit[]
  /** Set when the network failed and this page came off the on-disk copy. */
  staleSince: number | null
}

export type InstalledExtension = {
  id: string
  namespace: string
  name: string
  displayName: string
  version: string
  description: string
  path: string
}

export async function openvsxSearch(query: string): Promise<OpenVsxPage> {
  return invoke<OpenVsxPage>('openvsx_search', { query })
}

export async function extensionsList(root: string): Promise<InstalledExtension[]> {
  return invoke<InstalledExtension[]>('extensions_list', { root })
}

export async function extensionsInstall(
  root: string,
  namespace: string,
  name: string,
): Promise<InstalledExtension> {
  return invoke<InstalledExtension>('extensions_install', { root, namespace, name })
}

export async function extensionsUninstall(root: string, id: string): Promise<void> {
  return invoke('extensions_uninstall', { root, id })
}
