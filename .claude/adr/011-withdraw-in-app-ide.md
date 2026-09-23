# ADR 011 — Withdraw the in-app IDE workbench

- Status: accepted
- Date: 2026-09-20
- Tags: ide, vscode, monaco, extensions
- Supersedes: editor/Open VSX slices of [ADR 004](004-keep-tauri-reference-vscode.md)

## Context

P06 added a Monaco editor pane and an Open VSX subset so Flashwork could feel like an IDE without forking VS Code (ADR 004). The result was a second, incomplete editor beside the orchestrator: extra panes, extra Marketplace tab, extra navigation, and none of the VS Code quality the owner expected.

The owner asked to **remove the in-app IDE**. Flashwork stays a local-first agent/PTY orchestrator. Editing source happens in VS Code via the existing `open_in_vscode` hatch.

## Decision

1. **Remove** the Monaco editor pane, `workspace_*` editor IO, Open VSX install/search, and applied VSX theme.
2. **Keep** the orchestrator: Home, workspace terminals, Task Board, Marketplace MCP/skills, Source Control, Flows beta, `open_in_vscode`.
3. Files in the sidebar **preview** or **open in VS Code**. They do not open an in-app editor.
4. ADR 004 still forbids forking vscode. It no longer requires an in-app Monaco workbench.

## Consequences

- Persisted `kind: 'editor'` panes are dropped on load.
- Theme remains Flashwork built-in palettes (Preferences), not Open VSX.
- `.flashwork/extensions/` on disk is unused leftover; Flashwork does not delete user folders.
