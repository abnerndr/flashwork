export type ClaudeWriterLock = {
  runId: string
  sessionId: string
  ownerTerminalId: string | null
  canonicalTerminalId?: string
}

const locks = new Map<string, ClaudeWriterLock>()

export function rememberCanonicalClaude(
  runId: string,
  sessionId: string,
  terminalId?: string,
): void {
  const current = locks.get(runId)
  if (current) {
    if (terminalId && !current.canonicalTerminalId) {
      locks.set(runId, { ...current, canonicalTerminalId: terminalId })
    }
    return
  }
  locks.set(runId, {
    runId,
    sessionId,
    ownerTerminalId: null,
    canonicalTerminalId: terminalId,
  })
}

export function tryAcquireClaudeWriter(
  runId: string,
  terminalId: string,
): 'acquired' | 'wait' | 'missing' {
  const lock = locks.get(runId)
  if (!lock) return 'missing'
  if (lock.ownerTerminalId && lock.ownerTerminalId !== terminalId) return 'wait'
  locks.set(runId, { ...lock, ownerTerminalId: terminalId })
  return 'acquired'
}

export function releaseClaudeWriter(runId: string, terminalId: string): void {
  const lock = locks.get(runId)
  if (!lock || lock.ownerTerminalId !== terminalId) return
  locks.set(runId, { ...lock, ownerTerminalId: null })
}

export function canonicalClaudeSessionId(runId: string): string | undefined {
  return locks.get(runId)?.sessionId
}

export function canonicalClaudeTerminalId(runId: string): string | undefined {
  return locks.get(runId)?.canonicalTerminalId
}

export function findRunIdByCanonicalSession(sessionId: string): string | undefined {
  for (const lock of locks.values()) {
    if (lock.sessionId === sessionId) return lock.runId
  }
  return undefined
}

export function restoreCanonicalClaudeFromRun(run: {
  id: string
  canonicalClaudeSessionId?: string
  canonicalClaudeTerminalId?: string
}): void {
  if (!run.canonicalClaudeSessionId) return
  rememberCanonicalClaude(run.id, run.canonicalClaudeSessionId, run.canonicalClaudeTerminalId)
}

export function clearClaudeWriterLocks(): void {
  locks.clear()
}
