import { AGENT_TYPE_LABELS, type AgentType } from '../types'

export function buildRunBootstrapInput(args: {
  runId: string
  prompt: string
  agent: AgentType
  role?: 'orchestrator' | 'worker'
  skillNames?: readonly string[]
  allowedFiles?: readonly string[]
  boardPath?: string
  contextDir?: string
}): string {
  const label = AGENT_TYPE_LABELS[args.agent]
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
