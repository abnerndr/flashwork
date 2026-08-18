export type TaskKind = 'implement' | 'review' | 'mechanical' | 'explore' | 'unknown'

const IMPLEMENT =
  /\b(implement|refactor|build|fix|add|change|migrate|create|wire|feature)\b/i
const REVIEW = /\b(review|audit|security|nits?|approve)\b/i
const MECHANICAL =
  /\b(test suite|unit tests?|generate tests?|lint|format|chore|mechanical)\b/i
const EXPLORE = /\b(explain|how does|what does|explore|investigate|where is)\b/i

export function classifyTask(prompt: string): TaskKind {
  const text = prompt.trim()
  if (!text) return 'unknown'
  if (REVIEW.test(text)) return 'review'
  if (MECHANICAL.test(text)) return 'mechanical'
  if (EXPLORE.test(text)) return 'explore'
  if (IMPLEMENT.test(text)) return 'implement'
  return 'unknown'
}
