import type { AgentType, PromptRunStatus, PromptRunStep, TaskSlicePlan } from '../types'

export function retargetSlicePlan(
  slices: readonly TaskSlicePlan[],
  fromTerminalId: string,
  next: { agent: AgentType; terminalId: string },
): TaskSlicePlan[] {
  return slices.map((slice) =>
    slice.terminalId === fromTerminalId
      ? { ...slice, agent: next.agent, terminalId: next.terminalId, status: 'running' }
      : slice,
  )
}

export function failSlicePlan(
  slices: readonly TaskSlicePlan[],
  terminalId: string,
): TaskSlicePlan[] {
  return slices.map((slice) =>
    slice.terminalId === terminalId ? { ...slice, status: 'failed' as const } : slice,
  )
}

export function boardCardSettled(plan: readonly TaskSlicePlan[]): boolean {
  return plan.every((slice) => slice.status === 'done' || slice.status === 'failed')
}

export function slicesAfterLaunch(
  slicePlan: readonly TaskSlicePlan[],
  launchedIds: readonly string[],
  steps: readonly Pick<PromptRunStep, 'terminalId'>[],
  runStatus: PromptRunStatus,
): TaskSlicePlan[] {
  const launchedStatus = runStatus === 'done' ? ('done' as const) : ('running' as const)
  return slicePlan.map((slice) => {
    const index = launchedIds.indexOf(slice.id)
    if (index < 0) return slice
    return { ...slice, status: launchedStatus, terminalId: steps[index]?.terminalId }
  })
}

export function laneContextFromPlan(
  slices: readonly TaskSlicePlan[] | undefined,
  terminalId: string,
): {
  failedKind: TaskSlicePlan['kind'] | null
  siblingKinds: Array<TaskSlicePlan['kind']>
  slicePrompt: string | null
} {
  if (!slices?.length) {
    return { failedKind: null, siblingKinds: [], slicePrompt: null }
  }
  const failed = slices.find((slice) => slice.terminalId === terminalId)
  return {
    failedKind: failed?.kind ?? null,
    siblingKinds: slices
      .filter(
        (slice) =>
          slice.terminalId &&
          slice.terminalId !== terminalId &&
          (slice.status === 'running' || slice.status === 'pending'),
      )
      .map((slice) => slice.kind),
    slicePrompt: failed?.prompt ?? null,
  }
}
