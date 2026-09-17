# IDE workbench — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real editor workbench behind the orchestrator (file tree, tabs, Monaco) and a **subset** of VS Code-compatible extensions via Open VSX / monaco-vscode-api — without forking [microsoft/vscode](https://github.com/microsoft/vscode).

**Architecture:** New pane kind `editor` next to terminals. Phase A is Monaco + disk IO via Tauri. Phase B adds `@codingame/monaco-vscode-api` + Open VSX install into `{folder}/.flashwork/extensions/`. Keep `open_in_vscode` as escape hatch.

**Tech Stack:** Monaco (`monaco-editor`), Tauri fs commands, optional `@codingame/monaco-vscode-api` in phase B.

**ADR:** `.claude/adr/004-keep-tauri-reference-vscode.md`  
**Depends on:** P04 (project folder), P05 recommended for SCM in the same sidebar.

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/types.ts` | `Terminal.kind` / pane kind `'editor'` (follow existing `graphify` pane kind pattern in `PaneArea.tsx`) |
| `src/components/EditorPane/` | New: tree + tabs + monaco host |
| `src/lib/tauri/workspaceFs.ts` | read/write/list, confined to `defaultCwd` |
| `src-tauri/src/workspace_fs.rs` | Commands |
| `src/components/WorkspaceView/PaneArea.tsx` | Render editor kind |
| Phase B: `src/lib/extensions/` | Open VSX client |
| `package.json` | Add monaco; phase B codingame packages |

---

### Task 1: Confined workspace FS (Rust)

- [ ] **Step 1: Tests**

```rust
#[test]
fn read_refuses_path_outside_root() {
    let err = read_file("/tmp/root", "/etc/passwd").unwrap_err();
    assert!(err.contains("path_escape"));
}
```

- [ ] **Step 2: `workspace_list(root)`, `workspace_read(root, rel)`, `workspace_write(root, rel, contents)`**
- [ ] **Step 3: Skip `.flashwork/rag` binary blobs and `node_modules` in list (default ignore list)**
- [ ] **Step 4: TS wrappers**

Ignore list constant: `.git`, `node_modules`, `target`, `dist`, `.flashwork/rag`.

---

### Task 2: Editor pane (Phase A)

- [ ] **Step 1: Add pane kind following `terminal.kind === 'graphify'` in `PaneArea.tsx`**
- [ ] **Step 2: File tree (lazy expand) using workspace_list**
- [ ] **Step 3: Monaco editor, theme mapped from Flashwork `Theme` (vscode theme id → vs-dark)**
- [ ] **Step 4: Save with `Ctrl+S` → workspace_write; dirty dot on tab**
- [ ] **Step 5: "Open editor" action on project context menu**
- [ ] **Step 6: i18n + CHANGELOG**

Do not load the entire repo into RAM. Read one file at a time. Cap file size at 2 MiB with an explicit error.

Monaco must be dynamically imported so the terminal-only path does not pay the cost at boot:

```ts
const Monaco = lazy(() => import('./MonacoHost'))
```

---

### Task 3: Extensions subset (Phase B)

Only after Phase A is usable.

- [ ] **Step 1: Spike note in CHANGELOG if codingame API is adopted; add dependencies**
- [ ] **Step 2: Install target `{cwd}/.flashwork/extensions/<publisher>.<name>`**
- [ ] **Step 3: Allow: themes, language grammars, LSP-only language-features that codingame supports**
- [ ] **Step 4: Refuse Electron-only extension kinds with `extension_incompatible` toast**
- [ ] **Step 5: UI list under Marketplace (P02) as a third tab Extensions (beta)**

Do not implement a clone of the Microsoft Marketplace. Open VSX HTTP client only. Cache search results on disk like `mcp_registry_search`.

---

### Task 4: Integration with existing panes

- [ ] **Step 1: Opening a file from Explorer in the right sidebar markdown history remains; editor is for source files**
- [ ] **Step 2: Git SCM (P05) "Open file" focuses editor tab when kind is editor**
- [ ] **Step 3: Terminal "Open in VS Code" remains**

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| IDE behind current system | 2 |
| VS Code as UX base | 2–3 |
| Install vscode-like libs/extensions | 3 (subset) |
| Keep orchestrator | 4 |
