import { attachmentsDirFor, buildToolsJsonPayload } from '../taskBoard/attachments'
import { toAutoPromptRunProject } from '../promptRun/submitAutoPromptRun'
import { submitAutoPromptRun } from '../promptRun/submitAutoPromptRun'
import { isPromptRunBlocking } from '../promptRun/isPromptRunBlocking'
import { readPromptRunFile, taskWriteToolsJson } from '../tauri'
import type { FlowAgentNodeData, FlowRunNode } from './types'
import type { PromptRun, PromptRunStatus, Project, TaskToolSelection } from '../types'
import { usePromptRunStore } from '../../stores/promptRunStore'

const TERMINAL: PromptRunStatus[] = ['done', 'failed', 'cancelled', 'interrupted']
const WAIT_MS = 15 * 60 * 1000
const POLL_MS = 400

export type FlowAgentContext = {
  project: Project
  cwd: string
}

function asAgentData(data: Record<string, unknown>): FlowAgentNodeData {
  const prompt = typeof data.prompt === 'string' ? data.prompt : ''
  const attachments = Array.isArray(data.attachments)
    ? (data.attachments as FlowAgentNodeData['attachments'])
    : undefined
  const toolSelection =
    data.toolSelection && typeof data.toolSelection === 'object'
      ? (data.toolSelection as TaskToolSelection)
      : undefined
  return { prompt, attachments, toolSelection }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function waitForRun(projectId: string, runId: string): Promise<PromptRun> {
  const started = Date.now()
  while (Date.now() - started < WAIT_MS) {
    const run = usePromptRunStore.getState().byProjectId[projectId]
    if (run?.id === runId && TERMINAL.includes(run.status)) return run
    await sleep(POLL_MS)
  }
  throw new Error('agent_timeout')
}

async function outputFromRun(run: PromptRun): Promise<string> {
  try {
    const text = (await readPromptRunFile(run.id, 'api-reply.md')).trim()
    if (text) return text
  } catch {
    /* CLI runs write the reply into the PTY, not api-reply.md */
  }
  return `run:${run.id}`
}

export async function runFlowAgent(
  node: FlowRunNode,
  input: string,
  context: FlowAgentContext,
): Promise<string> {
  const data = asAgentData(node.data)
  const prompt = [data.prompt.trim(), input.trim()].filter(Boolean).join('\n\n')
  if (!prompt) throw new Error('agent_prompt_empty')
  const existing = usePromptRunStore.getState().byProjectId[context.project.id]
  if (
    existing &&
    isPromptRunBlocking(
      existing.status,
      [existing.activeTerminalId, ...existing.steps.map((step) => step.terminalId)].filter(
        (id): id is string => Boolean(id),
      ),
      context.project.terminals.map((terminal) => terminal.id),
    )
  ) {
    throw new Error('run-active')
  }
  let toolsJsonPath: string | undefined
  const selection = data.toolSelection
  if (selection) {
    const payload = buildToolsJsonPayload(selection, { mcpServerIds: [], skillNames: [] })
    try {
      toolsJsonPath = await taskWriteToolsJson(`flow-${node.id}`, JSON.stringify(payload, null, 2))
    } catch (cause) {
      if (selection.mode === 'restrict') throw cause
    }
  }
  const result = await submitAutoPromptRun({
    project: toAutoPromptRunProject(context.project),
    cwd: context.cwd,
    prompt,
    attachmentsDir: attachmentsDirFor(data.attachments),
    toolsJsonPath,
  })
  if (!result.ok) throw new Error(result.code)
  const finished =
    TERMINAL.includes(result.run.status) ? result.run : await waitForRun(context.project.id, result.run.id)
  if (finished.status !== 'done') throw new Error(`agent_${finished.status}`)
  return outputFromRun(finished)
}
