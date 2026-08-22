export type TaskKind = 'implement' | 'review' | 'mechanical' | 'explore' | 'ui' | 'unknown'

const IMPLEMENT =
  /\b(implement|implementar|refactor|refatorar|build|construir|fix|corrigir|add|adicionar|change|migrate|migrar|create|criar|wire|feature)\b/i
const REVIEW = /\b(review|revisar|audit|auditar|auditoria|security|segurança|nits?|approve)\b/i
const MECHANICAL =
  /\b(test suite|unit tests?|generate tests?|gerar testes(?: unitários)?|testes unitários|suíte de testes|suite de testes|escrever testes|fazer testes|e testes\b|lint|format|formatar|chore|mechanical)\b/i
const EXPLORE =
  /\b(explain|explicar|how does|como funciona|what does|o que faz|explore|investigar|investigate|where is|onde está)\b/i
const UI =
  /\b(ui|css|html|layout|frontend|front-end|tailwind|shadcn|figma|modal|stylesheet|visual|interface|tela|botão|botao|componente|estilo|restyle)\b/i

const KIND_PATTERNS: Array<{ kind: Exclude<TaskKind, 'unknown'>; pattern: RegExp }> = [
  { kind: 'implement', pattern: IMPLEMENT },
  { kind: 'mechanical', pattern: MECHANICAL },
  { kind: 'review', pattern: REVIEW },
  { kind: 'explore', pattern: EXPLORE },
  { kind: 'ui', pattern: UI },
]

export function classifyTaskKinds(prompt: string): Array<Exclude<TaskKind, 'unknown'>> {
  const text = prompt.trim()
  if (!text) return []
  return KIND_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind)
}

export function classifyTask(prompt: string): TaskKind {
  const text = prompt.trim()
  if (!text) return 'unknown'
  if (REVIEW.test(text)) return 'review'
  if (MECHANICAL.test(text)) return 'mechanical'
  if (UI.test(text)) return 'ui'
  if (EXPLORE.test(text)) return 'explore'
  if (IMPLEMENT.test(text)) return 'implement'
  return 'unknown'
}
