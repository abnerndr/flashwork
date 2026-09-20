import { invoke } from '@tauri-apps/api/core'

export type WorkspaceEntry = {
  name: string
  rel: string
  isDir: boolean
}

export async function workspaceList(root: string, rel = ''): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>('workspace_list', { root, rel })
}

export async function workspaceRead(root: string, rel: string): Promise<string> {
  return invoke<string>('workspace_read', { root, rel })
}

export async function workspaceWrite(root: string, rel: string, contents: string): Promise<void> {
  await invoke('workspace_write', { root, rel, contents })
}
