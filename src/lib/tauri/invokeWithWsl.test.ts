import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ preferences: { wslEnabled: true, wslDefaultDistro: 'Ubuntu' } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../platform', () => ({ isWindows: () => true }))
vi.mock('../../stores/projectsStore', () => ({ useProjectsStore: { getState: () => state } }))

import { invoke } from '@tauri-apps/api/core'
import { invokeWithWsl } from './invokeWithWsl'

describe('execution environment IPC', () => {
  beforeEach(() => vi.clearAllMocks())
  it('selects WSL without rewriting the Windows working directory', async () => {
    state.preferences.wslEnabled = true
    await invokeWithWsl('spawn_pty', { cwd: 'E:\\project' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'wsl_set_default_distro', { distro: 'Ubuntu' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'spawn_pty', { cwd: 'E:\\project' })
  })
  it('clears the WSL runtime when Windows is selected', async () => {
    state.preferences.wslEnabled = false
    await invokeWithWsl('spawn_pty', { cwd: 'E:\\project' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'wsl_set_default_distro', { distro: null })
  })
})
