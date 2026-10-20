import type { PtyStatus, SpecTask } from '../types'

/** How long every running lane must sit idle before DeepSeek nudges it. */
export const SPEC_STALL_MS = 45_000

const FALLBACK_NUDGE =
  'Continue and finish this task now. Do not ask questions. Complete the remaining work from your original prompt.'

export function specWorkUnfinished(tasks: readonly { status: SpecTask['status'] }[]): boolean {
  return tasks.some((task) => task.status === 'pending' || task.status === 'running')
}

/**
 * Every running coding lane is idle and the SPEC is not finished.
 * A single lane still marked working keeps the run out of this state.
 */
export function stalledSpecTasks(
  tasks: readonly SpecTask[],
  runtime: Readonly<Record<string, { status: PtyStatus; lastIoAt: number } | undefined>>,
  now: number,
  stallMs = SPEC_STALL_MS,
): SpecTask[] {
  if (!specWorkUnfinished(tasks)) return []
  const running = tasks.filter(
    (task) => task.status === 'running' && task.agent !== 'shell' && task.terminalId,
  )
  if (running.length === 0) return []
  const stalled = running.filter((task) => {
    const row = runtime[task.terminalId as string]
    if (!row || row.status === 'working') return false
    return row.status === 'waiting' && now - row.lastIoAt >= stallMs
  })
  return stalled.length === running.length ? stalled : []
}

export function buildSpecContinuePrompt(spec: string, tasks: readonly SpecTask[]): string {
  const lines = tasks
    .map((task) => `- ${task.id}: ${task.title}\n  ${task.prompt.slice(0, 600)}`)
    .join('\n')
  return [
    'These coding CLIs stopped and are waiting for a person. The SPEC is not finished.',
    'Write one short instruction per task so that CLI continues and finishes without asking more questions.',
    'Reply with ONLY JSON: {"nudges":[{"id":"t1","message":"continue and do X"}]}',
    'SPEC:',
    spec.trim().slice(0, 2000),
    'Waiting tasks:',
    lines,
  ].join('\n')
}

export function parseContinueNudges(text: string, tasks: readonly SpecTask[]): Record<string, string> {
  const nudges: Record<string, string> = {}
  for (const task of tasks) nudges[task.id] = FALLBACK_NUDGE
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return nudges
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      nudges?: { id?: unknown; message?: unknown }[]
    }
    for (const nudge of parsed.nudges ?? []) {
      if (typeof nudge.id !== 'string' || typeof nudge.message !== 'string') continue
      const message = nudge.message.trim()
      if (message && nudges[nudge.id]) nudges[nudge.id] = message
    }
  } catch {
    // Keep the fallback instruction for every stalled task.
  }
  return nudges
}
