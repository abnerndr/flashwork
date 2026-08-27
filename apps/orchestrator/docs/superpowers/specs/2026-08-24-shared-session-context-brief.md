---
pdf_options:
  format: A4
  margin:
    top: 22mm
    right: 18mm
    bottom: 22mm
    left: 18mm
  printBackground: true
---

<style>
  @page { size: A4; }
  html { font-size: 11pt; }
  body {
    font-family: "IBM Plex Sans", "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.45;
    max-width: 100%;
  }
  h1 { font-size: 1.7rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.15rem; margin: 1.6rem 0 0.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
  h3 { font-size: 1rem; margin: 1.1rem 0 0.35rem; }
  p, li { margin: 0.35rem 0; }
  .meta { color: #555; font-size: 0.92rem; margin-bottom: 1rem; }
  .lead {
    background: #f4f6f5;
    border-left: 3px solid #1f6f4a;
    padding: 0.7rem 0.9rem;
    margin: 1rem 0 1.3rem;
  }
  .kicker { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.72rem; color: #1f6f4a; font-weight: 600; margin: 0; }
  code, pre { font-family: "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; font-size: 0.86em; }
  code { background: #eef1f0; padding: 0.08em 0.28em; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 0.6rem 0 1rem; }
  th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #e2e2e2; padding: 0.4rem 0.5rem 0.4rem 0; }
  th { color: #444; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .note {
    background: #fff8e8;
    border-left: 3px solid #c48a00;
    padding: 0.7rem 0.9rem;
    margin: 1rem 0;
  }
  .footer { margin-top: 1.6rem; color: #666; font-size: 0.8rem; }
  ul { padding-left: 1.15rem; }
</style>

<p class="kicker">Flashwork · briefing técnico</p>
<h1>Contexto compartilhado entre agentes</h1>
<p class="meta">24 de agosto de 2026 · estado <strong>implementado</strong> (Fase 2) · para leitura de outro dev</p>

<div class="lead">

Irmãos de um run Auto compartilham a sessão Claude **sem pagar a API para copiar o transcript**. Handoff e o first prompt injetam um **ponteiro** para chunks em disco. Duas CLIs diferentes ainda não compartilham o mesmo composer — compartilham o **conteúdo** da sessão, não o processo.

</div>

## Por que isso existe

No Auto, vários panes (Claude, Codex, Gemini…) trabalham no mesmo pedido. Antes, cada pane nascia com uma conversa nova e o Flashwork tentava “passar contexto” colando histórico no `initialInput` — até ~48 KB. Isso:

1. cobrava tokens só para copiar o passado;
2. duplicava sessões Claude (`already claimed → fresh writer`);
3. não dividia o trabalho: um agente fazia tudo, os outros autenticavam e falhavam.

A Fase 2 troca o dump por um **hub local** e **uma** sessão Claude canônica por run.

## Arquitetura em uma frase

Um writer Claude (PTY + JSONL + `sessionId`) → o Flashwork indexa esse JSONL em disco, sem modelo → irmãos Claude fazem `--resume` da mesma id; Codex/Gemini/etc. leem chunks.

```
Canonical Claude          Context hub (0 tokens de API)
PTY + JSONL + mutex  →    runs/<runId>/context/
                          chunks/  manifest.json  index.json
                                ↓
              Claude irmão          Codex / Gemini         Handoff
              --resume + lock       ponteiro + Read        mesmo hub
```

Disco: `{profile}/runs/{runId}/context/` (mesmo root do journal). Chunks extrativos (~4 KB, agrupados por arquivo tocado). Índice lexical (termos + paths). Sem embedding API.

---

## 1. Como compartilhar entre sessões?

**Uma sessão Claude canônica por run Auto:** um JSONL, um writer PTY, um `sessionId` (`PromptRun.canonicalClaudeSessionId`).

| De → para | O que acontece |
|---|---|
| Claude → Claude | Não cria conversa nova. `--resume` da id canônica. Se outro pane segura o writer, **espera** o lock (até 120 s). |
| Claude → Codex / Gemini / OpenCode | Não entram no processo do Claude. Consomem o hub em `runs/<id>/context/`. |
| Handoff Claude ↔ Codex | `materialize_agent_handoff` grava o mesmo hub em `handoffs/<id>/context/`. `contextPath` = `manifest.json`. `--add-dir` aponta para `contextDir`. |

O que **não** é compartilhado como processo vivo: duas CLIs não digitam no mesmo TUI. Dois processos Claude não escrevem a mesma `sessionId` ao mesmo tempo — por isso o mutex.

## 2. Dá para reusar sessão sem gastar tokens?

**Para copiar histórico para outro modelo: sim — 0 tokens de API.** Parse do JSONL, split em chunks (`CHUNK_CHAR_CAP = 4000`) e índice invertido são locais. Sem embed, sem chat/completions para montar o hub.

**O próximo turno útil ainda cobra** o que aquele CLI enviar (slice + chunks que ele `Read`). A economia é **não reingerir ~48 KB** como first prompt.

| Ação | Tokens de modelo |
|---|---|
| Parse JSONL + chunk + índice local | **0** |
| Bootstrap do irmão (ponteiro, ≲ 2k chars) | irrisório, um shot |
| Agente lê o chunk `0003.md` | só aquele chunk |
| Segundo Claude `--resume` a mesma sessão | **0** para duplicar (não há duplicata); o turno seguinte é um turno Claude normal no mesmo prefixo |
| Capsule antigo (~48k no `initialInput`) | **proibido** |

Refresh do watcher (`shouldIngestContext` + debounce 800 ms): **0** chamadas de chat.

## 3. O que acontece com as sessões Claude? Duplica?

**Não, dentro de um run.**

- Primeira lane Claude: `--session-id` com UUID uma vez → `rememberCanonicalClaude` + persist no `PromptRun`.
- Claude posterior no mesmo run: `--resume` dessa id, ou **espera** o lock.
- Conflito de claim dessa id **não** cai no `already claimed; starting a fresh writer`.
- `planAutoLanes` emite no máximo um worker `agent === 'claude'`.
- Retry de early-exit na sessão canônica **não** força UUID novo.

Outros CLIs nunca ganham uma sessão Claude forjada. Ganham arquivos.

O lock de writer é in-memory e é restaurado do `PromptRun` persistido no `setRun` / hydrate.

## 4. Como o contexto passa? Ainda injeta no first prompt?

**Só um ponteiro.**

Auto (`buildRunBootstrapInput`): papel + slice + `contextDir` absoluto + “leia `manifest.json` e só os chunks que batem nos seus arquivos.” Para um prompt curto, o texto fica **&lt; 2k chars**.

Handoff (`buildIndexBootstrap`): o mesmo ponteiro + o pedido do usuário. **Não** o corpo da capsule.

O modelo **puxa** vetores pequenos (chunks) com Read quando precisa. Qualidade é extrativa (turnos reais + arquivos tocados), não um resumo feito por LLM.

Exemplo do que o Codex recebe no first prompt:

```
[Flashwork Auto] You are a worker (Codex) for run {id}.
Do the assigned slice. Do not paste or request the sibling transcript.
Shared context is on disk at "{abs}/context". Read manifest.json and only
the chunks that match your files. The index was built locally with no API cost.

{slice do usuário}
```

---

## Antes × agora

| Pergunta | Antes | Agora |
|---|---|---|
| Compartilhar | Board markdown + first prompt gordo; sessão nova por pane | Uma sessão Claude + hub local |
| Reuso sem tokens | Resume só no mesmo pane; Auto mintava chat novo | Resume canônico; índice de graça para construir |
| Irmãos Claude | Segundo pane = JSONL novo (`fresh writer`) | Mesmo JSONL, lock, `--resume` |
| Passar contexto | Transcript/capsule no `initialInput` | Caminho; chunks em disco |

## Limites honestos (vale a pena falar)

- `prepare_agent_handoff` ainda monta um **rascunho interno** da conversa para ter texto a chunkar. O que mudou é o que entra no `initialInput`.
- Se prepare/materialize falha (ou a origem não é Claude/Codex), o fallback ainda aponta o **journal + pedido do usuário**.
- O próximo turno de qualquer CLI continua cobrado pelo provedor.
- Duas CLIs não compartilham um composer vivo. Isso é restrição dos produtos, não um TODO nosso.

## Onde olhar no código

| Peça | Arquivo |
|---|---|
| Mint / resume da sessão canônica | `src/lib/promptRun/startPromptRun.ts` |
| Mutex de writer | `src/lib/promptRun/claudeWriterLock.ts` |
| `--session-id` vs `--resume` | `src/lib/sessionLaunch.ts`, `useXtermSession.ts` |
| Bootstrap ponteiro | `src/lib/promptRun/bootstrapPrompt.ts` |
| Handoff ponteiro | `src/lib/promptRun/executeHandoff.ts` |
| Chunk + índice (TS) | `src/lib/promptRun/contextChunks.ts` |
| Hub + ingest (Rust) | `src-tauri/src/context_hub.rs` |
| Ingest ao vivo | `src/hooks/usePromptRunWatcher.ts` |

<p class="footer">Flashwork Orchestrator · briefing interno para compartilhar · não é spec de produto. Testes no momento da implementação: 451 passing (Vitest) + testes do módulo <code>context_hub</code>.</p>
