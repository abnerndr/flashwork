import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { isWindows } from '../platform'

/** Keep host filesystem paths intact while selecting the runtime for Windows folders. */
export async function syncWslPreferences(): Promise<void> {
  if (isWindows()) {
    const { useProjectsStore } = await import('../../stores/projectsStore')
    const preferences = useProjectsStore.getState().preferences
    await invoke('wsl_set_default_distro', {
      distro: preferences.wslEnabled ? preferences.wslDefaultDistro || null : null,
    })
  }
}

export async function invokeWithWsl<T>(command: string, args?: InvokeArgs): Promise<T> {
  await syncWslPreferences()
  return invoke<T>(command, args)
}
