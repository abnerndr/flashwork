import type { AgentType, PtyStatus, SpecTask } from '../types'
import { QUOTA_HANDOFF_THRESHOLD } from './constants'
import { HANDOFF_PREF, isAgentAuthError, isAgentLoginBlock } from './detectHandoffTrigger'
import { isSpecWorkerAgent } from './specPlan'

const CREDIT_EXHAUSTED_PATTERN =
  /429|rate[\s-]?limit|quota exceeded|usage limit|out of credits|insufficient credit|credit balance/i

export function isCreditExhausted(input: {
  agent: AgentType
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  ptyChunk: string
  laneStatus: PtyStatus | 'unknown'
}): boolean {
  if (input.agent === 'shell') return false
  if (input.laneStatus === 'working') return false
  if (isAgentLoginBlock(input.ptyChunk) || isAgentAuthError(input.ptyChunk)) return false
  if (CREDIT_EXHAUSTED_PATTERN.test(input.ptyChunk)) return true
  if (input.agent === 'codex' && input.codexRateLimited) return true
  if (input.agent === 'claude' && input.claudeFiveHourUtilization != null && input.claudeFiveHourUtilization >= 100) {
    return true
  }
  return false
}

/**
 * True when a SPEC lane shows a credit-related signal that the credit queue owns, so the legacy
 * handoff must neither open a pane nor drop the lane. Login blocks and auth errors stay with the
 * legacy path.
 */
export function specLaneSkipsLegacyHandoff(input: {
  isSpecLane: boolean
  agent: AgentType
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  ptyChunk: string
}): boolean {
  if (!input.isSpecLane || input.agent === 'shell') return false
  if (isAgentLoginBlock(input.ptyChunk) || isAgentAuthError(input.ptyChunk)) return false
  if (CREDIT_EXHAUSTED_PATTERN.test(input.ptyChunk)) return true
  if (input.agent === 'codex' && input.codexRateLimited) return true
  return (
    input.agent === 'claude' &&
    input.claudeFiveHourUtilization != null &&
    input.claudeFiveHourUtilization >= QUOTA_HANDOFF_THRESHOLD
  )
}

/** A ready slice whose CLI already ran out of credit in this run is queued instead of launched. */
export function readyTaskMustQueue(task: Pick<SpecTask, 'agent'>, exhausted: readonly AgentType[] | undefined): boolean {
  return isSpecWorkerAgent(task.agent) && (exhausted ?? []).includes(task.agent)
}

export function withQueuedSlice(tasks: readonly SpecTask[], terminalId: string, now: number): SpecTask[] {
  return tasks.map((task) =>
    task.terminalId === terminalId && task.status === 'running'
      ? { ...task, status: 'queued' as const, queuedAt: now, terminalId: undefined }
      : task,
  )
}

/** Finds the slice that owns a pane, preferring the running one when several share the id. */
export function pickTaskForTerminal(tasks: readonly SpecTask[] | undefined, terminalId: string): SpecTask | undefined {
  const matches = (tasks ?? []).filter((task) => task.terminalId === terminalId)
  return matches.find((task) => task.status === 'running') ?? matches[0]
}

export function withExhaustedAgent(current: readonly AgentType[] | undefined, agent: AgentType): AgentType[] {
  const list = current ?? []
  if (!isSpecWorkerAgent(agent) || list.includes(agent)) return [...list]
  return [...list, agent]
}

export function oldestQueuedCodingSlice(tasks: readonly SpecTask[]): SpecTask | null {
  const queued = tasks.filter(
    (task) => task.status === 'queued' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent),
  )
  if (queued.length === 0) return null
  return [...queued].sort((left, right) => (left.queuedAt ?? 0) - (right.queuedAt ?? 0))[0] ?? null
}

export function codingSliceRunning(tasks: readonly SpecTask[]): boolean {
  return tasks.some((task) => task.status === 'running' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent))
}

export function decideCreditQueue(tasks: readonly SpecTask[], eligible: readonly AgentType[]): 'wait' | 'open' | 'fail' {
  if (codingSliceRunning(tasks)) return 'wait'
  if (eligible.length > 0) return 'open'
  return 'fail'
}

export function failQueuedCodingSlices(tasks: readonly SpecTask[]): SpecTask[] {
  return tasks.map((task) =>
    task.status === 'queued' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent)
      ? { ...task, status: 'failed' as const }
      : task,
  )
}

export function buildCreditContinuation(input: {
  runId: string
  task: Pick<SpecTask, 'id' | 'title' | 'prompt'>
  boardPath?: string
  journalPath?: string
  doneIds: readonly string[]
}): string {
  const lines = [
    'The previous CLI stopped because credit ran out. Finish only this slice.',
    `Slice ${input.task.id} "${input.task.title}" of run ${input.runId}.`,
  ]
  if (input.boardPath) lines.push(`Shared board: ${input.boardPath}`)
  if (input.journalPath) lines.push(`Run journal: ${input.journalPath}`)
  lines.push(`Slices already done: ${input.doneIds.length > 0 ? input.doneIds.join(', ') : 'none'}`)
  lines.push('', input.task.prompt)
  return lines.join('\n')
}

export type CreditDelivery =
  | { kind: 'type'; tasks: SpecTask[]; terminalId: string; text: string }
  | { kind: 'open'; tasks: SpecTask[]; taskId: string; agent: AgentType; text: string }
  | { kind: 'fail'; tasks: SpecTask[] }
  | { kind: 'none'; tasks: SpecTask[] }

export function deliveryAfterFinish(input: {
  tasks: readonly SpecTask[]
  finishedAgent: AgentType
  finishedTerminalId: string
  eligible: readonly AgentType[]
  runId: string
  boardPath?: string
  journalPath?: string
}): CreditDelivery {
  const queued = oldestQueuedCodingSlice(input.tasks)
  if (!queued) return { kind: 'none', tasks: [...input.tasks] }
  const doneIds = input.tasks.filter((task) => task.status === 'done').map((task) => task.id)
  const text = buildCreditContinuation({
    runId: input.runId,
    task: queued,
    boardPath: input.boardPath,
    journalPath: input.journalPath,
    doneIds,
  })
  const finisherCanTakeIt = input.finishedAgent !== 'shell' && isSpecWorkerAgent(input.finishedAgent)
  if (finisherCanTakeIt) {
    return {
      kind: 'type',
      terminalId: input.finishedTerminalId,
      text,
      tasks: input.tasks.map((task) => {
        if (task.id === queued.id) {
          return {
            ...task,
            status: 'running' as const,
            agent: input.finishedAgent,
            terminalId: input.finishedTerminalId,
            queuedAt: undefined,
          }
        }
        // The pane now belongs to the queued slice; drop stale ownership so lookups stay unambiguous.
        return task.terminalId === input.finishedTerminalId ? { ...task, terminalId: undefined } : task
      }),
    }
  }
  if (codingSliceRunning(input.tasks)) return { kind: 'none', tasks: [...input.tasks] }
  const agent = HANDOFF_PREF.find((item) => input.eligible.includes(item)) ?? input.eligible[0]
  if (!agent) return { kind: 'fail', tasks: failQueuedCodingSlices(input.tasks) }
  return { kind: 'open', taskId: queued.id, agent, text, tasks: [...input.tasks] }
}
