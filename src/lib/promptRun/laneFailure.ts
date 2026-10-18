import type { TaskKind } from './classifyTask'
import type { HandoffTriggerKind } from './detectHandoffTrigger'

export type LaneFailureAction = 'handoff-run' | 'drop-lane' | 'retarget-slice'

export type DecideLaneFailureInput = {
  liveStepCount: number
  failedKind: TaskKind | null
  siblingKinds: readonly TaskKind[]
  trigger: HandoffTriggerKind
  loginBlocked?: boolean
}

export function decideLaneFailure(input: DecideLaneFailureInput): LaneFailureAction {
  if (input.liveStepCount <= 1) return 'handoff-run'
  if (input.loginBlocked) return 'drop-lane'
  if (input.failedKind && input.siblingKinds.includes(input.failedKind)) return 'drop-lane'
  if (input.trigger === 'error' || input.trigger === 'quota') return 'retarget-slice'
  return 'handoff-run'
}
