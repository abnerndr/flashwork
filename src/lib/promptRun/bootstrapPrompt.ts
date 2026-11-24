import type { RoutedAgent, SpecTask } from '../types'
import { routedAgentLabel } from './routedAgent'

export const GRAPHIFY_BOOTSTRAP_NOTE =
  'Prefer `graphify query` / Graphify MCP before broad file reads.'

/** Max siblings inlined into a SPEC bootstrap; the rest live on the board only. */
export const SPEC_BOOTSTRAP_SIBLING_CAP = 6

export function buildRunBootstrapInput(args: {
  runId: string
  prompt: string
  agent: RoutedAgent
  role?: 'orchestrator' | 'worker'
  skillNames?: readonly string[]
  allowedFiles?: readonly string[]
  boardPath?: string
  contextDir?: string
}): string {
  const label = routedAgentLabel(args.agent)
  if (args.role === 'orchestrator') {
    return [
      `[Flashwork Auto] Orchestrator ${label} for run ${args.runId}. Coordinate; do not implement everything.`,
      '',
      args.prompt,
    ].join('\n')
  }
  const skills =
    args.skillNames && args.skillNames.length > 0
      ? `Skills: ${args.skillNames.join(', ')}.`
      : 'Do your slice only. Do not paste sibling transcripts.'
  const lines = [`[Flashwork Auto] Worker ${label} · run ${args.runId}.`, skills]
  if (args.contextDir) {
    lines.push(
      `Context hub: ${args.contextDir} — read manifest.json and only matching chunks (local index, no API cost).`,
    )
  }
  if (args.boardPath) {
    lines.push(`Board: ${args.boardPath} — read first, write findings, do not redo siblings.`)
  }
  if (args.allowedFiles && args.allowedFiles.length > 0) {
    lines.push(`Files only: ${args.allowedFiles.join(', ')}`)
  }
  lines.push('', args.prompt)
  return lines.join('\n')
}

/**
 * Bootstrap typed into one Run SPEC lane. The board path is relative to the project root so a
 * CLI running inside WSL (Linux paths) resolves it the same way as a Windows one.
 * Keep this short: sibling ownership details live on the board when the roster is large.
 */
export function buildSpecTaskBootstrap(args: {
  runId: string
  task: Pick<SpecTask, 'id' | 'title' | 'prompt' | 'files' | 'agent'>
  siblings: ReadonlyArray<Pick<SpecTask, 'id' | 'title' | 'files' | 'agent'>>
  boardPath?: string
}): string {
  const { task } = args
  const lines = [
    `[Flashwork SPEC] ${task.id} "${task.title}" (${routedAgentLabel(task.agent)}) · run ${args.runId}.`,
    GRAPHIFY_BOOTSTRAP_NOTE,
  ]
  if (args.boardPath) {
    lines.push(
      `Board (project-relative): ${args.boardPath} — read first; append status under your task id; do not redo siblings.`,
    )
  }
  if (task.files.length > 0) {
    lines.push(`Own files only: ${task.files.join(', ')}`)
  }
  const others = args.siblings.filter((sibling) => sibling.id !== task.id)
  if (others.length > 0) {
    const shown = others.slice(0, SPEC_BOOTSTRAP_SIBLING_CAP)
    lines.push('Siblings:')
    for (const sibling of shown) {
      const files = sibling.files.length > 0 ? sibling.files.join(', ') : 'whole repo'
      lines.push(`- ${sibling.id} · ${sibling.title} · ${routedAgentLabel(sibling.agent)} · ${files}`)
    }
    const rest = others.length - shown.length
    if (rest > 0) {
      lines.push(`- … +${rest} more on the board (not repeated here to save tokens)`)
    }
  }
  lines.push('', task.prompt)
  return lines.join('\n')
}
