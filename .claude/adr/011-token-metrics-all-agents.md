# ADR 011 — Token metrics and agent identity for every CLI

- Status: proposed
- Date: 2026-09-17
- Tags: tokens, usage, gemini, hud

## Context

The Token HUD and Home usage widgets look complete for Claude and mostly for Codex. They are not:

- `agentCostStore.liveAgentSessions` **drops** any agent that is not `claude` | `codex` | `opencode`, and requires a session id. Gemini, Copilot, Antigravity, Mimo, Freebuff never appear.
- `get_session_cost` returns `agente sem custo suportado` for anything else. Pricing only matches Opus/Sonnet/Haiku names.
- Home `UsageStrip` renders Claude + Codex (Antigravity only inside the usage modal). No Gemini card.
- Resume/session snapshot exists for Claude, Codex, OpenCode, Antigravity only (`RESUMABLE_AGENTS`). Gemini has no `geminiSessionId`, no `gemini_sessions.rs`.
- Identity for the HUD uses `SavedSession.agent` plus Claude’s session id as a fallback field — a Gemini pane is invisible, not “Gemini with $0”.

The owner: token control (spent tokens, cost, windows) must work for the other agents, not only Claude; Flashwork also fails to **identify** terminals such as Gemini.

## Decision

1. **Identity source of truth** is the live pane: `tab.type` / spawn `AgentType` on the PTY, not “has a Claude jsonl”. Every live non-shell agent pane is a HUD row.
2. **Cost** is best-effort per agent, same `SessionCost` shape. Missing parser ⇒ tokens/cost null, row still labeled with the correct agent icon and cwd.
3. **Quota widgets** (5h/week style) stay vendor-specific. v1 cards: Claude, Codex, Antigravity (already), Gemini, OpenCode summary, Copilot if the CLI exposes usage. Mimo/Freebuff: session tokens only until a quota API exists.
4. **Resume + cost** for Gemini: add session snapshot like the other four resumable CLIs. Copilot/Mimo/Freebuff follow the same pattern if they write a session file; otherwise PTY scrape + no resume.
5. Direct provider API calls (ADR 010) write a synthetic `SessionCost` into the same store so Auto-without-CLI still meters spend.
6. Token HUD remains optional to *start* work (ADR 006) but must be **accurate when shown**.

## Consequences

- `pricing_for` becomes a table keyed by model family (Claude, GPT, Gemini, …) plus `get_model_pricing` already in Tauri — not Haiku/Sonnet/Opus only.
- CLI resolver must find `gemini` the same way it finds `claude` (nvm/fnm/npm global, `~/.local/bin`, Homebrew). Aliases: `gemini`, `gemini-cli`.
- Do not fake Claude 5h meters for Gemini. Different vendors, different widgets, one HUD list.
