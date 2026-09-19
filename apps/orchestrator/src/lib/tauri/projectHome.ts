import { invoke } from '@tauri-apps/api/core'

export type ProjectHomeMeta = {
  id: string
  createdAt: number
  schemaVersion: number
}

export async function projectBootstrap(folder: string, projectId: string): Promise<string> {
  return invoke<string>('project_bootstrap', { folder, projectId })
}

export async function projectDetect(folder: string): Promise<ProjectHomeMeta | null> {
  return invoke<ProjectHomeMeta | null>('project_detect', { folder })
}
