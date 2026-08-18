import { AGENT_TYPE_LABELS, type AgentType } from '../types'

export function buildRunBootstrapInput(args: {
  runId: string
  prompt: string
  agent: AgentType
  journalPath: string
}): string {
  const label = AGENT_TYPE_LABELS[args.agent]
  return [
    `[Flashwork Auto] You are the active agent (${label}) for run ${args.runId}.`,
    `Read the run journal at "${args.journalPath}" if that file exists.`,
    'Do the user request below. Flashwork may later hand off to another CLI with a context capsule.',
    '',
    args.prompt,
  ].join('\n')
}
