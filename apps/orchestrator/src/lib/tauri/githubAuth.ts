import { invoke } from '@tauri-apps/api/core'

export type GithubRepoAuthSource = 'gh' | 'keyring' | null

export type GithubRepoAuthStatus = {
  connected: boolean
  source: GithubRepoAuthSource
  login: string | null
}

export type GithubDeviceStart = {
  sessionId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export type GithubDevicePollStatus = 'pending' | 'complete' | 'denied' | 'expired' | 'error'

export type GithubDevicePoll = {
  status: GithubDevicePollStatus
  /** GitHub asked the client to wait longer before the next poll. */
  slowDown?: boolean
  /** Next interval in seconds when GitHub sent one with `slow_down`. */
  interval?: number
}

export async function githubRepoAuthStatus(): Promise<GithubRepoAuthStatus> {
  return invoke<GithubRepoAuthStatus>('github_repo_auth_status')
}

export async function githubRepoDeviceStart(): Promise<GithubDeviceStart> {
  return invoke<GithubDeviceStart>('github_repo_device_start')
}

export async function githubRepoDevicePoll(sessionId: string): Promise<GithubDevicePoll> {
  return invoke<GithubDevicePoll>('github_repo_device_poll', { sessionId })
}

export async function githubRepoAuthLogout(): Promise<GithubRepoAuthStatus> {
  return invoke<GithubRepoAuthStatus>('github_repo_auth_logout')
}

/** Push/pull errors that mean the user should sign in to GitHub. */
export function looksLikeGitAuthError(error: unknown): boolean {
  const message = String(error)
  return /Authentication failed|could not read Username|\b403\b|\b401\b/i.test(message)
}
