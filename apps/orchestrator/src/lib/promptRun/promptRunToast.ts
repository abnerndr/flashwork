import type { MessageKey } from '../i18n'
import type { PromptRunStatus } from '../types'

export function promptRunOutcomeToast(status: PromptRunStatus): {
  titleKey: MessageKey
  bodyKey: MessageKey
} {
  if (status === 'done') {
    return { titleKey: 'promptRun.finishedTitle', bodyKey: 'promptRun.finishedBody' }
  }
  return { titleKey: 'promptRun.startedTitle', bodyKey: 'promptRun.startedBody' }
}
