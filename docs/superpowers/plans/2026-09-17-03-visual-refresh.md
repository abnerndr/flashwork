# Visual refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make icons readable at sidebar density and switch the UI to a more attractive, VS Code–like type stack without abandoning Flashwork tokens.

**Architecture:** Keep CSS variables. Change `--font-sans` / `--font-mono`, add `--icon-stroke` rules, and audit lucide sizes in the sidebar, title bar, and Task Board. Use VS Code workbench density as a **reference** (see vscode-docs editor/UI), not a pixel clone of the Microsoft product.

**Tech Stack:** CSS Modules, `theme.css`, `docs/BRAND.md`, lucide-react.

**ADR:** `.claude/adr/004-keep-tauri-reference-vscode.md`  
**Existing tokens:** `apps/orchestrator/docs/BRAND.md`, `docs/UI_VISUAL_STYLES.md`

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/styles/theme.css` | Font tokens, icon size tokens |
| `src/styles/reset.css` | Body font |
| `docs/BRAND.md` | Document the new stack |
| `src/components/icons/AgentIcons.tsx` | Min size 16, currentColor-friendly |
| Sidebar CSS modules | Icon + label gap, no 10px labels on icons |
| `index.html` | Font stylesheet links if we self-host or use system stack |

---

### Task 1: Type tokens

Decision locked in this plan (no TBD):

- **Sans:** `"Segoe UI Variable", "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif`  
  Segoe UI is the VS Code / Windows workbench face; Inter stays as fallback (already used).
- **Mono:** `"Cascadia Code", "Cascadia Mono", "Sarasa Mono", Consolas, ui-monospace, monospace`  
  Cascadia Code is VS Code's terminal/editor direction; we already list Cascadia Mono.
- Load **no Google Fonts CDN** (local-first, no extra network on boot). Ship Inter only if already bundled; otherwise system stack.

- [ ] **Step 1: Update `--font-sans` and `--font-mono` in `theme.css`**
- [ ] **Step 2: Set `body { font-family: var(--font-sans); font-feature-settings: "ss01" 0; }` if not already**
- [ ] **Step 3: Update `docs/BRAND.md` Typography table**
- [ ] **Step 4: CHANGELOG Changed**

Do not introduce Tailwind. Do not add gradients.

---

### Task 2: Icon readability

Rules:

1. Default lucide size in trees/toolbars: **16**, not 12.
2. Stroke width: `1.75` via lucide `strokeWidth` on shared `UiIcon` wrapper.
3. Agent brand images: min **16×16**, `image-rendering: auto`, no opacity below 0.7 for inactive (Clean style already mutes — bump inactive to 0.7).
4. Hit target: 28px min in Clean (`--clean-row-height` is 30 — keep). Icon-only buttons `min-width/min-height: 28px`.

- [ ] **Step 1: Create `src/components/ui/UiIcon.tsx`**

```tsx
import { type LucideProps } from 'lucide-react'

export function UiIcon({
  icon: Icon,
  size = 16,
  strokeWidth = 1.75,
  ...rest
}: LucideProps & { icon: React.ComponentType<LucideProps> }) {
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden {...rest} />
}
```

- [ ] **Step 2: Replace raw `<Trash2 size={12} />` in `TaskBoardView` and `GitControl` with `UiIcon`**
- [ ] **Step 3: Sidebar `ProjectSidebar` / `normalSidebarPrimitives` — grep `size={12}` and `size={10}` under `src/components` and lift to 16 except inline badges**
- [ ] **Step 4: Visual check in both `normal` and `clean` styles** (browser or `dev:ui`)

Grep command:

```
rg "size=\{1[0-2]\}" src/components --glob "*.tsx"
```

---

### Task 3: VS Code–like chrome (CSS only)

Inspired by vscode workbench (activity bar + sidebar), without building the editor yet:

- Activity-style **left rail** already exists as `ProjectSidebar`. Increase section label contrast to `--text-secondary`.
- Pane headers: 35px height (vscode tab-ish), not 22px.
- Focused pane border: use `--accent` at 1px in Normal; keep Clean's `--clean-focus-border`.

- [ ] **Step 1: Tokens `--workbench-tab-height: 35px` and `--workbench-icon: 16px` in `theme.css`**
- [ ] **Step 2: Apply to `WorkspaceView` pane chrome and `TitleBar`**
- [ ] **Step 3: Update `docs/UI_VISUAL_STYLES.md` with the new tokens**

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| More readable icons | 2 |
| More attractive font | 1 |
| VS Code as visual base (chrome) | 3 |
