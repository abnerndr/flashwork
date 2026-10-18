import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

                                                                        
                                                                        
                                                 
export async function agentHooksEndpoint(): Promise<string> {
  return invoke('agent_hooks_endpoint')
}

export async function agentHooksToken(): Promise<string> {
  return invoke<string>('agent_hooks_token')
}

/** Caminho do settings.json de hooks gerado pro Claude Code (agent_events.rs). */
export async function agentHooksSettingsPath(): Promise<string> {
  return invoke<string>('agent_hooks_settings_path')
}

export type InstalledAgent = { name: string; from_flashwork: boolean }

                                                                      
export async function listInstalledAgents(folder: string): Promise<InstalledAgent[]> {
  return invoke<InstalledAgent[]>('list_installed_agents', { folder })
}

                                                                          
                                                                        
                                                                    
export async function installAgent(args: {
  folder: string
  name: string
  content: string
  force: boolean
}): Promise<string> {
  return invoke<string>('install_agent', args)
}

                                      
export async function uninstallAgent(folder: string, name: string, force = true): Promise<void> {
  await invoke('uninstall_agent', { folder, name, force })
}

export type DiscoveredModel = { id: string; label: string }

export async function discoverProviderModels(provider: string): Promise<DiscoveredModel[]> {
  return invoke<DiscoveredModel[]>('discover_provider_models', { provider })
}

export type OpenCodeBridgeStatus = {
  directory: string
  state: 'working' | 'idle'
}

                                                                        
                                                                  
export function listenOpenCodeBridgeStatus(
  handler: (payload: OpenCodeBridgeStatus) => void,
): Promise<UnlistenFn> {
  return listen<OpenCodeBridgeStatus>('opencode-bridge-status', (event) => handler(event.payload))
}

// --- RFC-012 — Plugin System ---

export type PluginKind = 'agentType' | 'skill' | 'validationPipeline'

export type PluginManifest = {
  name: string
  version: string
  kind: PluginKind
  description: string
  spec: Record<string, unknown>
}

export async function pluginsList(kind?: PluginKind): Promise<PluginManifest[]> {
  return invoke<PluginManifest[]>('plugins_list', { kind })
}

export async function pluginInstall(manifest: PluginManifest): Promise<void> {
  await invoke('plugin_install', { manifest })
}

export async function pluginUninstall(id: string): Promise<void> {
  await invoke('plugin_uninstall', { id })
}
