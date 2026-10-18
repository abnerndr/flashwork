import { invoke } from '@tauri-apps/api/core'

export type SkillSummary = {
  name: string
  agent: string
  path: string
  resolvedPath: string
  description: string
  linked: boolean
  shared: boolean
  bundled: boolean
  entryCount: number
}

export type SkillAgentSnapshot = {
  agent: string
  root: string | null
  exists: boolean
  skills: SkillSummary[]
}

export type SkillNode = {
  name: string
  path: string
  isDir: boolean
  size: number
  children: SkillNode[]
  truncated: boolean
}

export type SkillLockInfo = {
  source: string | null
  sourceUrl: string | null
  installedAt: string | null
  updatedAt: string | null
}

export type SkillDetail = {
  summary: SkillSummary
  frontmatter: Record<string, string>
  frontmatterRaw: string
  body: string
  tree: SkillNode[]
  lock: SkillLockInfo | null
}

export type SkillRemoveReport = {
  path: string
  removedLinkOnly: boolean
  sharedCopyPath: string | null
}

export async function skillsScan(): Promise<SkillAgentSnapshot[]> {
  return invoke<SkillAgentSnapshot[]>('skills_scan')
}

export async function skillsDetail(agent: string, name: string): Promise<SkillDetail> {
  return invoke<SkillDetail>('skills_detail', { agent, name })
}

export async function skillsUninstall(agent: string, name: string): Promise<SkillRemoveReport> {
  return invoke<SkillRemoveReport>('skills_uninstall', { agent, name })
}

export type SkillInstallRequest = {
  source: { type: 'folder'; path: string } | { type: 'git'; url: string }
  agents: string[]
  overwrite?: boolean
}

export async function skillsInstall(req: SkillInstallRequest): Promise<SkillSummary> {
  return invoke<SkillSummary>('skills_install', { req })
}
