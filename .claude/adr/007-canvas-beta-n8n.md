# ADR 007 — Canvas beta is N8N-like, separate from Task Board

- Status: accepted
- Date: 2026-09-17
- Tags: canvas, beta, n8n

## Context

`AgentCanvasPOC` visualizes live agent sessions and workers. The owner wants a **beta tab** like n8n: nodes for agents, then send the result to another agent, an HTTP API, a text block, or a filter.

Task Board already orchestrates implementation slices. Mixing general automation into Task Board would blur "get this coded" with "pipe data through tools".

## Decision

1. Ship a new **Flows** view (feature flag `canvasFlows`, default off except a visible Beta badge).
2. Node types v1: `agent`, `text`, `filter`, `http`, `mcpTool`. Edges carry the previous node's text/JSON payload.
3. Execution is local (Tauri). HTTP nodes require explicit user confirmation per domain until a project allowlist exists.
4. Do not delete `AgentCanvasPOC` in v1; keep it as the session inspector. A later ADR may merge the two canvases.
5. Persist graphs under the project's `.flashwork/history/flows/` (ADR 005).

## Consequences

- Layout and graph library: prefer extending existing DnD + CSS in the POC **or** a small dedicated store; do not pull the n8n codebase.
- Agent nodes reuse `submitBoardTask` / prompt-run spawn paths so routing (ADR 006) and MCP/skill allowlists (ADR 008) apply.
