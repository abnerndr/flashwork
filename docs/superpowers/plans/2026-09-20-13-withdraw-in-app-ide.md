# P13 — Withdraw the in-app IDE

> Owner named this slice: remove the Monaco/Open VSX workbench. Flashwork is the orchestrator again.

**Goal:** Delete the in-app editor and Open VSX marketplace. Opening a file goes to preview or VS Code.

**ADR:** `.claude/adr/011-withdraw-in-app-ide.md`

## Keep

- Home, workspace grid, terminals, Task Board, Flows (beta)
- Marketplace MCP + skills
- Source Control (P05)
- `open_in_vscode` / reveal in file explorer
- File preview, markdown sidebar, add-to-grid for media

## Remove

- `EditorPane/`, Monaco, `monaco-editor` dependency
- `createEditorPane` / `makeEditorPane` / `kind: 'editor'` panes (drop on migrate)
- `openInEditor.ts`, `requestEditorOpen`, `ensureEditorForProject`
- Open VSX UI (`ExtensionsBrowser`) and `openvsx.rs` commands
- `workspace_fs.rs` editor IO
- `useAppliedVsxTheme` applying VSX tokens to chrome

## Tasks

1. Persist: strip editor panes and `appliedVsxTheme` on `migrate()`.
2. Frontend: no editor pane, no Extensions tab, Files/Git use preview or VS Code.
3. Backend: unregister `workspace_*` and `openvsx_*` / `extensions_*`.
4. Changelog + CONTEXT + PROGRESS.
