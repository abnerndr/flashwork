import { AGENT_TYPE_LABELS, type AgentType, type PromptRun, type PromptRunStep } from '../types'
import {
  codingSliceRunning,
  decideCreditQueue,
  deliveryAfterFinish,
  failQueuedCodingSlices,
  oldestQueuedCodingSlice,
  withExhaustedAgent,
  withQueuedSlice,
} from './creditQueue'
import { specHandoffAgents } from './specPlan'

const seenCredit = new Set<string>()

export type SpecCreditPorts = {
  now: () => number
  appendBoard: (cwd: string, runId: string, heading: string, body: string) => Promise<unknown>
  appendJournal: (runId: string, heading: string, body: string) => Promise<unknown>
  deleteTerminal: (projectId: string, terminalId: string) => void
  patchRun: (projectId: string, patch: Partial<PromptRun>) => void
  getRun: (projectId: string) => PromptRun | undefined
  launchPane: (args: {
    projectId: string
    cwd: string
    runId: string
    agent: AgentType
    name: string
    bootstrap: string
  }) => Promise<{ terminalId: string }>
  writePty: (ptyId: string, data: string) => Promise<void>
  ptyIdFor: (projectId: string, terminalId: string) => string | null
  toast: (toast: { title: string; body: string; agent?: AgentType }) => void
  continueRun: (projectId: string) => Promise<void>
  finishIfSettled: (projectId: string) => Promise<void>
  label: (agent: AgentType) => string
  copy: {
    waitTitle: string
    waitBody: string
    openTitle: string
    failTitle: string
    failBody: string
  }
}

function eligibleAgents(run: PromptRun): AgentType[] {
  const pool = specHandoffAgents(run) ?? []
  const blocked = new Set(run.exhaustedAgents ?? [])
  return pool.filter((agent) => !blocked.has(agent))
}

async function noteStop(run: PromptRun, task: { id: string; title: string; agent: AgentType }, ports: SpecCreditPorts) {
  const heading = `${task.id} stopped (${AGENT_TYPE_LABELS[task.agent]})`
  const body = `Task "${task.title}" stopped because credit ran out.`
  await ports.appendBoard(run.cwd, run.id, heading, body).catch(() => undefined)
  await ports.appendJournal(run.id, heading, body).catch(() => undefined)
}

async function openOldest(
  run: PromptRun,
  tasks: PromptRun['specTasks'],
  agent: AgentType,
  taskId: string,
  bootstrap: string,
  ports: SpecCreditPorts,
): Promise<void> {
  const created = await ports.launchPane({
    projectId: run.projectId,
    cwd: run.cwd,
    runId: run.id,
    agent,
    name: `${taskId} · ${AGENT_TYPE_LABELS[agent]}`,
    bootstrap,
  })
  const now = ports.now()
  const step: PromptRunStep = { agent, reason: 'quota', startedAt: now, terminalId: created.terminalId }
  // Re-read: patches may have landed while the pane was launching.
  const live = ports.getRun(run.projectId)
  const latest = live ?? run
  const baseTasks = live?.specTasks ?? tasks
  ports.patchRun(run.projectId, {
    specTasks: (baseTasks ?? []).map((task) =>
      task.id === taskId
        ? { ...task, status: 'running' as const, agent, terminalId: created.terminalId, queuedAt: undefined }
        : task,
    ),
    steps: [...latest.steps, step],
    activeAgent: agent,
    activeTerminalId: created.terminalId,
  })
  const opened = (tasks ?? []).find((item) => item.id === taskId)
  const agentLabel = AGENT_TYPE_LABELS[agent]
  ports.toast({
    title: ports.copy.openTitle.replace(/\{agent\}/g, agentLabel),
    body: opened?.title ?? agentLabel,
    agent,
  })
}

type QueueContext = { sourceAgent?: AgentType; terminalId?: string }

function failQueued(run: PromptRun, tasks: PromptRun['specTasks'], ports: SpecCreditPorts, ctx: QueueContext) {
  ports.patchRun(run.projectId, { specTasks: failQueuedCodingSlices(tasks ?? []) })
  ports.toast({ title: ports.copy.failTitle, body: ports.copy.failBody, agent: ctx.sourceAgent })
}

/**
 * Opens the pane for a queued slice. A launch failure must not leave the run stuck: the slice stays
 * queued only while another coding slice can still pick it up; otherwise the queue fails.
 */
async function openOrSettle(
  run: PromptRun,
  tasks: PromptRun['specTasks'],
  agent: AgentType,
  taskId: string,
  bootstrap: string,
  ports: SpecCreditPorts,
  ctx: QueueContext,
): Promise<boolean> {
  try {
    await openOldest(run, tasks, agent, taskId, bootstrap, ports)
    return true
  } catch (cause) {
    console.warn('[run-spec] credit pane launch failed:', cause)
    const liveTasks = (ports.getRun(run.projectId) ?? run).specTasks ?? tasks ?? []
    if (codingSliceRunning(liveTasks)) {
      if (ctx.terminalId) seenCredit.delete(`${run.id}:${ctx.terminalId}`)
      if (ctx.sourceAgent) {
        ports.toast({ title: ports.copy.waitTitle, body: ports.copy.waitBody, agent: ctx.sourceAgent })
      }
      return false
    }
    failQueued(run, liveTasks, ports, ctx)
    await ports.finishIfSettled(run.projectId)
    return false
  }
}

/** Decides what happens to the oldest queued slice. `run` must already hold the queued state. */
async function advanceQueue(run: PromptRun, ports: SpecCreditPorts, ctx: QueueContext): Promise<void> {
  const tasks = run.specTasks ?? []
  const eligible = eligibleAgents(run)
  const action = decideCreditQueue(tasks, eligible)
  if (action === 'wait') {
    if (ctx.sourceAgent) {
      ports.toast({ title: ports.copy.waitTitle, body: ports.copy.waitBody, agent: ctx.sourceAgent })
    }
    return
  }
  if (!oldestQueuedCodingSlice(tasks)) return
  if (action === 'fail') {
    failQueued(run, tasks, ports, ctx)
    await ports.finishIfSettled(run.projectId)
    return
  }
  const delivery = deliveryAfterFinish({
    tasks,
    finishedAgent: 'shell',
    finishedTerminalId: '',
    eligible,
    runId: run.id,
    boardPath: run.boardPath,
    journalPath: run.journalPath,
  })
  if (delivery.kind !== 'open') {
    failQueued(run, tasks, ports, ctx)
    await ports.finishIfSettled(run.projectId)
    return
  }
  await openOrSettle(run, tasks, delivery.agent, delivery.taskId, delivery.text, ports, ctx)
}

export async function handleSpecCreditExhausted(
  run: PromptRun,
  terminalId: string,
  sourceAgent: AgentType,
  ports: SpecCreditPorts,
): Promise<void> {
  if (!run.specTasks) return
  const key = `${run.id}:${terminalId}`
  if (seenCredit.has(key)) return
  const task = run.specTasks.find((item) => item.terminalId === terminalId && item.status === 'running')
  if (!task) return
  seenCredit.add(key)
  await noteStop(run, task, ports)
  // Re-read after the await: other lanes may have patched the run (or finished this slice) meanwhile.
  const live = ports.getRun(run.projectId)
  if (live && live.id !== run.id) return
  const current = live ?? run
  const liveTasks = current.specTasks ?? []
  if (!liveTasks.some((item) => item.terminalId === terminalId && item.status === 'running')) return
  const exhaustedAgents = withExhaustedAgent(current.exhaustedAgents, sourceAgent)
  const queued = withQueuedSlice(liveTasks, terminalId, ports.now())
  // No await between the re-read and this patch, so the queue state is built from the live run.
  ports.patchRun(run.projectId, { specTasks: queued, exhaustedAgents })
  try {
    ports.deleteTerminal(run.projectId, terminalId)
  } catch (cause) {
    console.warn('[run-spec] credit pane close failed:', cause)
  }
  await advanceQueue({ ...current, specTasks: queued, exhaustedAgents }, ports, { sourceAgent, terminalId })
}

/** Opens the next CLI with credit for the oldest queued slice when no coding slice is running. */
export async function openQueuedCodingSliceIfIdle(projectId: string, ports: SpecCreditPorts): Promise<void> {
  const run = ports.getRun(projectId)
  if (!run?.specTasks || run.status !== 'running') return
  await advanceQueue(run, ports, {})
}

export async function deliverFinishedSpecSlice(
  run: PromptRun,
  terminalId: string,
  ports: SpecCreditPorts,
): Promise<void> {
  if (!run.specTasks) return
  const finished = run.specTasks.find((task) => task.terminalId === terminalId)
  const delivery = deliveryAfterFinish({
    tasks: run.specTasks,
    finishedAgent: finished?.agent ?? 'shell',
    finishedTerminalId: terminalId,
    eligible: eligibleAgents(run),
    runId: run.id,
    boardPath: run.boardPath,
    journalPath: run.journalPath,
  })
  if (delivery.kind === 'none') {
    await ports.continueRun(run.projectId)
    await ports.finishIfSettled(run.projectId)
    return
  }
  if (delivery.kind === 'type') {
    ports.patchRun(run.projectId, { specTasks: delivery.tasks })
    const ptyId = ports.ptyIdFor(run.projectId, delivery.terminalId)
    if (ptyId) await ports.writePty(ptyId, `${delivery.text}\r`)
    await ports.continueRun(run.projectId)
    return
  }
  if (delivery.kind === 'fail') {
    ports.patchRun(run.projectId, { specTasks: delivery.tasks })
    ports.toast({ title: ports.copy.failTitle, body: ports.copy.failBody })
    await ports.finishIfSettled(run.projectId)
    return
  }
  const opened = await openOrSettle(
    { ...run, specTasks: delivery.tasks },
    delivery.tasks,
    delivery.agent,
    delivery.taskId,
    delivery.text,
    ports,
    {},
  )
  if (opened) await ports.continueRun(run.projectId)
}

export function resetSpecCreditSeen(): void {
  seenCredit.clear()
}
