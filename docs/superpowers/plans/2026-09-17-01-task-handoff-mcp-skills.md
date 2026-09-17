# Task handoff upload and MCP/skill picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Task Board card attach markdown handoff/spec files and select which local MCP servers and skills the run may use.

**Architecture:** Extend `TaskCard` with `attachments` and `toolSelection`. Copy or link files under a task-scoped folder. At spawn, write a pointer `tools.json` + `--add-dir` (or bootstrap path) instead of inlining file bodies. Reuse `mcp_scan` / `skills_scan` and `pickFiles`.

**Tech Stack:** TypeScript (Zustand, Vitest), Tauri `invoke`, existing `saveTaskCard` persistence.

**ADR:** `.claude/adr/008-task-handoff-and-tool-picker.md`

Paths below are relative to `apps/orchestrator/` unless noted.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/types.ts` | `TaskAttachment`, `TaskToolSelection`, fields on `TaskCard` |
| `src/lib/taskBoard/attachments.ts` | Parse markdown title, validate extensions, merge tool selection |
| `src/lib/taskBoard/attachments.test.ts` | Unit tests |
| `src/lib/taskBoard/boardMarkdown.ts` | List attachments and selected tools in the sibling markdown |
| `src/lib/taskBoard/submitBoardTask.ts` | Pass attachment dir + tools.json into the run bootstrap |
| `src/stores/taskBoardStore.ts` | Draft helper includes new fields |
| `src/components/TaskBoardView/index.tsx` | Upload + picker UI |
| `src/components/TaskBoardView/TaskToolPicker.tsx` | New: checkbox lists from scans |
| `src/lib/i18n/messages/en.ts` + `pt-BR.ts` | Strings |
| `src/lib/tauri/taskBoard.ts` | Unchanged invoke; Rust struct must match TS |
| `src-tauri/src/task_board.rs` | Add serde fields on `TaskCardRecord` (`attachments`, `tool_selection`) with `#[serde(default)]` |

---

### Task 1: Types and pure helpers

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/taskBoard/attachments.ts`
- Test: `src/lib/taskBoard/attachments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  HAND_OFF_EXTENSIONS,
  attachmentTitleFromMarkdown,
  isHandoffPath,
  resolveToolSelection,
} from './attachments'

describe('attachments', () => {
  it('accepts md markdown mdx only', () => {
    expect(isHandoffPath('/tmp/spec.md')).toBe(true)
    expect(isHandoffPath('/tmp/spec.mdx')).toBe(true)
    expect(isHandoffPath('/tmp/spec.txt')).toBe(false)
  })

  it('reads the first heading as title', () => {
    expect(attachmentTitleFromMarkdown('# Login handoff\n\nDo the thing')).toBe(
      'Login handoff',
    )
    expect(attachmentTitleFromMarkdown('no heading')).toBe('untitled')
  })

  it('projectDefault ignores ticks; restrict uses the lists', () => {
    expect(
      resolveToolSelection(
        { mode: 'projectDefault', mcpServerIds: ['x'], skillNames: ['y'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mcpServerIds: ['a'], skillNames: ['b'] })
    expect(
      resolveToolSelection(
        { mode: 'restrict', mcpServerIds: ['figma'], skillNames: ['qa'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mcpServerIds: ['figma'], skillNames: ['qa'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/taskBoard/attachments.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
export const HAND_OFF_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const

export function isHandoffPath(path: string): boolean {
  const lower = path.toLowerCase()
  return HAND_OFF_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function attachmentTitleFromMarkdown(body: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  const title = match?.[1]?.trim()
  return title && title.length > 0 ? title : 'untitled'
}

export type ToolSelection = {
  mode: 'projectDefault' | 'restrict'
  mcpServerIds: string[]
  skillNames: string[]
}

export function resolveToolSelection(
  selection: ToolSelection,
  projectDefaults: { mcpServerIds: string[]; skillNames: string[] },
): { mcpServerIds: string[]; skillNames: string[] } {
  if (selection.mode !== 'restrict') return projectDefaults
  return { mcpServerIds: [...selection.mcpServerIds], skillNames: [...selection.skillNames] }
}
```

Add to `TaskCard` in `types.ts`:

```ts
attachments?: TaskAttachment[]
toolSelection?: TaskToolSelection
```

with the types from the program spec.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/taskBoard/attachments.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit only if the owner asked**

---

### Task 2: Persist fields on the card draft

**Files:**
- Modify: `src/stores/taskBoardStore.ts`
- Modify: `src/lib/taskBoard/boardMarkdown.ts`
- Modify: `src/lib/taskBoard/boardMarkdown.test.ts`

- [ ] **Step 1: Extend `createTaskCardDraft`**

```ts
export function createTaskCardDraft(input: {
  projectId: string
  cwd: string
  title: string
  prompt: string
  allowedFiles: string[]
  priority: number
  verifyCommands?: string[]
  attachments?: TaskAttachment[]
  toolSelection?: TaskToolSelection
}): TaskCard {
  const now = Date.now()
  return {
    id: nanoid(),
    column: 'backlog',
    createdAt: now,
    updatedAt: now,
    attachments: input.attachments ?? [],
    toolSelection: input.toolSelection ?? {
      mode: 'projectDefault',
      mcpServerIds: [],
      skillNames: [],
    },
    ...input,
  }
}
```

- [ ] **Step 2: `renderBoardMarkdown` lists attachments and tools**

Assert in `boardMarkdown.test.ts` that a card with `attachments: [{ title: 'Handoff', storedPath: '/x.md' }]` contains `Handoff` and `storedPath`, and that restrict mode lists skill names.

- [ ] **Step 3: Run** `npx vitest run src/lib/taskBoard/boardMarkdown.test.ts`

---

### Task 3: Copy attachment into task history (Tauri)

**Files:**
- Create: `src/lib/tauri/taskAttachments.ts`
- Modify: `src-tauri/src/task_board.rs` (`TaskCardRecord`, `save_task_card_inner`)
- Test: Rust copy confines the destination under the project folder (no zip-slip / path escape)

If P04 (`.flashwork/`) is not shipped yet, store under the existing profile task directory used by `task_board.rs` (same parent as the cards JSON), e.g.:

`{profile}/task-board/attachments/{cardId}/{safeFileName}`

Use the same `validate_card_id` helper already in `task_board.rs`. When P04 lands, migrate the path; do not block P01 on P04.

- [ ] **Step 1: Command `task_attach_markdown(cardId, sourcePath) -> TaskAttachment`**
- [ ] **Step 2: Reject non-markdown and paths that escape the destination**
- [ ] **Step 3: Frontend `pickFiles({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }] })` then invoke**

`pickFiles` already exists in `src/lib/dialog.ts`. `AddContentModal.tsx` already uses markdown filters — copy that filter list.

---

### Task 4: Tool picker UI

**Files:**
- Create: `src/components/TaskBoardView/TaskToolPicker.tsx`
- Modify: `src/components/TaskBoardView/index.tsx`
- Modify: i18n `en.ts` / `pt-BR.ts`
- Modify: `TaskBoardView.module.css` using tokens only

Behavior:

1. On composer open, `mcpScan` + `skillsScan` for the selected project's cwd (same repo resolution as `McpPanel`).
2. Two lists: servers grouped by name (`groupServersByName`), skills grouped by name (`groupSkillsByName`).
3. Toggle **Restrict tools** (`toolSelection.mode = 'restrict'`).
4. Upload button **Attach handoff** next to the prompt textarea; chips for each attachment with remove.
5. `createCard` requires title + (prompt **or** at least one attachment). If only attachment, set `prompt` to `See attached: {title}`.

- [ ] **Step 1: i18n keys** (`taskBoard.attachHandoff`, `taskBoard.restrictTools`, `taskBoard.toolsDefault`, `taskBoard.attachNeedPromptOrFile`, …)
- [ ] **Step 2: Wire picker + upload in `createCard`**
- [ ] **Step 3: CHANGELOG `[Unreleased]` Added bullet**

---

### Task 5: Spawn path uses pointers

**Files:**
- Modify: `src/lib/taskBoard/submitBoardTask.ts`
- Modify: whatever builds `initialInput` / `--add-dir` for Auto (see `TerminalPane` handoff `contextDir`)

- [ ] **Step 1: When attachments exist, bootstrap text is pointer-only**

```
Task attachments are on disk. Read them:
{absoluteAttachmentsDir}
Selected tools (JSON): {absoluteToolsJson}
```

Do **not** concatenate markdown bodies into `prompt`.

- [ ] **Step 2: Write `tools.json` beside attachments with `resolveToolSelection(...)`**
- [ ] **Step 3: Unit test on a pure helper `buildTaskBootstrap({ prompt, attachmentsDir, toolsJsonPath })` expecting no raw `# heading` from the file body**

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| Upload `.md` handoff | 3, 4 |
| Map local MCP + skills | 4 |
| User selects which to use | 4, 5 |
| Pointers not transcript dump | 5 |
