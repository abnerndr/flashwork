# ADR 004 — Keep Tauri; reference VS Code, do not fork it

- Status: proposed
- Date: 2026-09-17
- Tags: ide, vscode, extensions

## Context

The owner asked to use [microsoft/vscode](https://github.com/microsoft/vscode) and [microsoft/vscode-docs](https://github.com/microsoft/vscode-docs) as the base for an IDE behind Flashwork, including GitHub/SCM quality comparable to VS Code and the ability to install VS Code libraries/extensions.

VS Code (Code - OSS) is an Electron + TypeScript workbench with its own extension host. Flashwork is Tauri + WebView. Forking vscode would discard the orchestrator, PTY layer, and AGPL product rather than "keep what we have".

## Decision

1. **Do not fork or vendor** the vscode repository.
2. Use vscode and vscode-docs as the **UX and behavior spec** for: workbench chrome, file explorer, editor tabs, Source Control (stage/commit/push/branch/GitHub), iconography, and density.
3. Implement the editor inside the existing Tauri WebView with **Monaco** plus, in a later slice, `@codingame/monaco-vscode-api` (or equivalent) so a **subset** of VS Code extensions (themes, language packs, LSP-based language features from Open VSX) can be installed.
4. Keep `open_in_vscode` as an escape hatch for full VS Code.
5. Native vscode extensions that require the Electron extension host (debug adapters tightly coupled to vscode UI, many UI contribs) are **out of scope** until a dedicated spike proves a sandbox. Document that limit in the IDE plan.

## Consequences

- Visual refresh can start immediately (fonts, icons, SCM layout) without waiting for an editor.
- "Install VS Code libs" means Open VSX / monaco-vscode-api compatible extensions, not the Microsoft Marketplace VSIX that depends on proprietary product bits.
- If monaco-vscode-api proves insufficient, a later ADR may allow embedding a local `code-server` sidecar. That is not the default.
