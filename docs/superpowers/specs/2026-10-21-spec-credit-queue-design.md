# Run SPEC credit queue — design

Date: 2026-10-21
Status: proposed
Builds on: ADR 013 (SPEC orchestrator), ADR 014 (DeepSeek planner), `src/lib/promptRun/runSpec.ts`, `src/hooks/usePromptRunWatcher.ts`

## Problem

Run SPEC splits one SPEC into parallel CLI lanes. When a lane runs out of credits, Flashwork often drops that slice if a sibling of the same kind is still running. The slice stops. Another CLI does not pick it up.

The owner wants the unfinished slice to wait for a CLI that still has credit, then continue in that CLI's pane after its current slice is done. A dead pane must close. If nobody else is working, the next CLI with credit opens immediately and the exhausted pane closes.

## Scope

This applies to a running Run SPEC (`run.specTasks` is set).

A non-SPEC Auto run keeps today's handoff: it may open a new pane immediately. Login and invalid-API-key failures keep today's path. They do not enter this queue.

Out of this spec: attaching several SPEC files, CLI install on Linux and Windows, and terminal symbol spacing.

## Decisions

1. A credit block sets the slice to `queued`. The exhausted pane closes.
2. While another coding slice is `running`, the queue waits. No new pane opens.
3. When a coding CLI finishes its slice, the oldest queued coding slice is typed into that same pane.
4. When no coding slice is `running`, the next CLI with credit opens at once, receives the slice, and the exhausted pane closes.
5. A CLI that blocked on credit stays out of this run. It can be used again on a later run.
6. A shell pane never receives a coding slice.
7. When every coding CLI for this run is exhausted and none is `running`, the slice becomes `failed`.

## Status

`SpecTaskStatus` gains `queued`:

`pending | running | queued | done | failed`

`queued` means the CLI stopped because credit ran out and the slice is waiting for a coding CLI to become free.

Add `queuedAt?: number` on `SpecTask`. The oldest `queuedAt` leaves the queue first.

Add `exhaustedAgents?: AgentType[]` on the prompt run. This list is for the current run only. It does not use the session-wide auth-failed set.

`specRunSettled` treats `queued` as unfinished. A run does not finish while a slice is queued. `readySpecTasks` launches only `pending` slices whose dependencies are `done`. A queued slice is not launched as a new pane by that path.

## Credit signal

A slice enters the queue only when the lane is not `working` and one of these is true:

- The terminal text reports a provider refusal: `429`, rate limit, quota exceeded, usage limit, out of credits, or an insufficient credit balance.
- Codex is marked rate limited.
- Claude's five-hour utilization is 100.

Utilization below 100 does not close the pane. A credit phrase that appears while the lane status is `working` does not enqueue. That covers a stray `429` inside code the CLI is still writing.

## When credit runs out

Order:

1. Append a note to `.flashwork/runs/<runId>/board.md` and to the run journal: slice id, agent, reason `credits exhausted`.
2. Set that slice to `queued`, set `queuedAt` to now, and append the agent to `exhaustedAgents`.
3. Close the pane with `deleteTerminal`. That already kills the PTY. If the close fails, the slice stays `queued`.
4. If any other coding slice is `running`, stop. Toast: the agent stopped for credit and the slice waits for the next CLI to finish.
5. If no coding slice is `running`, open the next CLI with credit. Eligible means installed, selected for this run, absent from `exhaustedAgents`, and a SPEC worker (`shell` and `gemini` stay out). Among those, use the existing handoff preference order. The slice returns to `running` on the new pane. Toast names the agent that is continuing.

If step 5 has no eligible CLI, set the slice to `failed` and toast that no CLI with credit can continue. The run may then finish through the existing settled check.

The same rules apply if the CLI that picked up a queued slice later runs out of credit.

## When a CLI finishes its slice

`noteSpecTerminalComplete` still marks that slice `done` and writes the existing board line.

Then:

1. If this pane is a coding CLI and a coding slice is `queued`, take the oldest one.
2. Retarget that slice to this pane and this agent. Status returns to `running`.
3. Type the continuation into the live PTY. No new pane opens.
4. Pending slices that just became ready still follow `continueSpecRun`, except the slice just taken from the queue.

If the pane that finished is a shell, leave the queue untouched. If no coding slice is `running` after that, run the immediate-open step from the credit-block path.

One queued slice is delivered per completion.

## Continuation text

The text given to the next CLI contains only:

- slice id and title
- the full slice prompt
- the board path `.flashwork/runs/<runId>/board.md`
- the journal path when one exists
- the ids of slices already `done`
- one line: the previous CLI stopped because credit ran out, and this CLI must finish only this slice

In the same pane, this text is written to the PTY after the CLI finishes its previous slice. In a new pane, it is the initial prompt. The full SPEC body is not pasted again.

The board note is written before the exhausted pane closes, so the next CLI can read where the previous one stopped.

## Interface

No new screen.

The SPEC progress bar counts `pending`, `running`, and `queued` as remaining. Percent is `done / total`, so a `failed` slice does not raise it and does not stay in the remaining count. The current title is the `running` slice. ETA keeps the current formula. The bar leaves the screen when the run status is no longer `running`.

Toasts, in English and pt-BR:

- Waiting: "{agent} stopped because credit ran out. This slice waits for the next CLI to finish."
- Opening: "Continuing on {agent}."
- No CLI left: "No CLI with credit left to continue. This slice failed."

The run board stores the same stop note the next CLI reads.

## Tests

Unit tests, with no real CLI process:

- With another coding slice `running`, a credit block sets the slice to `queued` and requests the pane close. No new pane is requested.
- With no coding slice `running`, the next CLI with credit is chosen, the slice returns to `running`, and the exhausted pane is closed.
- When a coding CLI finishes and the queue is non-empty, the oldest queued slice is aimed at that same pane. The continuation includes the slice prompt, the board path, the journal path, and the `done` ids.
- An agent in `exhaustedAgents` is not chosen again for this run.
- A shell pane does not receive a coding slice.
- When every coding CLI is exhausted and none is `running`, the slice becomes `failed`.
- Progress counts `queued` as remaining. Percent counts only `done`.
- A credit phrase while the lane is `working` does not enqueue. Claude utilization below 100 does not enqueue.
- `specRunSettled` is false while any slice is `queued`.

## Non-goals

- Reopening the exhausted CLI in the same run
- Merging the queued slice into a CLI that is still working
- Changing login, invalid key, or non-SPEC Auto handoff
- Several SPEC attachments, CLI install, or terminal glyph spacing
