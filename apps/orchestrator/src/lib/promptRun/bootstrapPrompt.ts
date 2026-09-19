import { buildTaskBootstrap } from '../taskBoard/attachments'
import type { RoutedAgent } from '../types'
import { routedAgentLabel } from './routedAgent'

export function buildRunBootstrapInput(args: {
  runId: string
  prompt: string
  agent: RoutedAgent
  role?: 'orchestrator' | 'worker'
  skillNames?: readonly string[]
  allowedFiles?: readonly string[]
  boardPath?: string
  contextDir?: string
  attachmentsDir?: string
  toolsJsonPath?: string
}): string {
  const label = routedAgentLabel(args.agent)
  const promptWithAttachments = buildTaskBootstrap({
    prompt: args.prompt,
    attachmentsDir: args.attachmentsDir,
    toolsJsonPath: args.toolsJsonPath,
  })
  if (args.role === 'orchestrator') {
    return [
      `[Flashwork Auto] You orchestrate run ${args.runId} as ${label}.`,
      'Do not implement the whole request yourself. Keep workers unblocked and summarize progress.',
      '',
      promptWithAttachments,
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
  lines.push('', promptWithAttachments)
  return lines.join('\n')
}
