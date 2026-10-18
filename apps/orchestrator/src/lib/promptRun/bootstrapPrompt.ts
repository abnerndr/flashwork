import type { RoutedAgent, SpecTask } from '../types'
import { routedAgentLabel } from './routedAgent'

export const GRAPHIFY_BOOTSTRAP_NOTE =
  'Use the graphify MCP / `graphify query` to understand the codebase before reading files.'

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
      `[Flashwork Auto] You orchestrate run ${args.runId} as ${label}.`,
      'Do not implement the whole request yourself. Keep workers unblocked and summarize progress.',
      '',
      args.prompt,
    ].join('\n')
  }
  const skills =
    args.skillNames && args.skillNames.length > 0
      ? `Prefer these installed skills: ${args.skillNames.join(', ')}.`
      : 'Do the assigned slice. Do not paste or request the sibling transcript.'
  const lines = [`[Flashwork Auto] You are a worker (${label}) for run ${args.runId}.`, skills]
  if (args.contextDir) {
    lines.push(
      `Shared context is on disk at "${args.contextDir}". Read manifest.json and only the chunks that match your files. The index was built locally with no API cost.`,
    )
  }
  if (args.boardPath) {
    lines.push(
      `Read the shared board at "${args.boardPath}" first. Write your findings there. Do not redo sibling slices.`,
    )
  }
  if (args.allowedFiles && args.allowedFiles.length > 0) {
    lines.push('You may only touch these files:')
    for (const file of args.allowedFiles) lines.push(`- ${file}`)
  }
  lines.push('', args.prompt)
  return lines.join('\n')
}

/**
 * Bootstrap typed into one Run SPEC lane. The board path is relative to the project root so a
 * CLI running inside WSL (Linux paths) resolves it the same way as a Windows one.
 */
export function buildSpecTaskBootstrap(args: {
  runId: string
  task: Pick<SpecTask, 'id' | 'title' | 'prompt' | 'files' | 'agent'>
  siblings: ReadonlyArray<Pick<SpecTask, 'id' | 'title' | 'files' | 'agent'>>
  boardPath?: string
}): string {
  const { task } = args
  const lines = [
    `[Flashwork SPEC] You are task ${task.id} "${task.title}" (${routedAgentLabel(task.agent)}) of run ${args.runId}.`,
    GRAPHIFY_BOOTSTRAP_NOTE,
  ]
  if (args.boardPath) {
    lines.push(
      `Shared board: ${args.boardPath} (path relative to the project root). Read it first: it lists every sibling task and the files each one owns.`,
      'Do not redo sibling tasks. When you finish, append your status and findings to the board under a heading with your task id.',
    )
  }
  if (task.files.length > 0) {
    lines.push('You own only these files (do not edit files owned by siblings):')
    for (const file of task.files) lines.push(`- ${file}`)
  }
  const others = args.siblings.filter((sibling) => sibling.id !== task.id)
  if (others.length > 0) {
    lines.push('Sibling tasks:')
    for (const sibling of others) {
      const files = sibling.files.length > 0 ? sibling.files.join(', ') : 'whole repo'
      lines.push(`- ${sibling.id} · ${sibling.title} · ${routedAgentLabel(sibling.agent)} · ${files}`)
    }
  }
  lines.push('', task.prompt)
  return lines.join('\n')
}
