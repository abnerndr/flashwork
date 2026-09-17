import { agentCliCommand, type AgentType } from './types'

   
                                                                              
                                                                            
                                                                   
  
                                                                        
                                                                                         
  
                                                                                
                       
   
export function buildGhosttyCommand(type: AgentType, extraArgs?: string[]): string | undefined {
  const command = agentCliCommand(type)
  if (!command) return undefined
  const parts = [command, ...(extraArgs ?? []).map(shellQuote)]
  return parts.join(' ')
}

/**
 * Ghostty's EXEC backend only takes `cfg.command` (no env map). Prefix POSIX `env`
 * so the CLI process receives caller variables without changing the shim FFI.
 */
export function prefixGhosttyCommandEnv(
  command: string,
  env?: Record<string, string>,
): string {
  if (!env) return command
  const assignments = Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
  if (assignments.length === 0) return command
  return `env ${assignments.join(' ')} ${command}`
}

function shellQuote(arg: string): string {
                                                                              
  if (/^[A-Za-z0-9_\-./=:@]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}
