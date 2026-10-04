# S-07 — Live run monitor

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: watch any in-flight agent run (WF-05) — transcript, progress
vs plan, commits, live spend — with kill / pause / hand-off controls.
One component serves every stage: triage, design, implement, review,
fix, rebase, revert, survey, interview, probe.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K                                                     │
├────────────┬──────────────────────────────────────────────┬──────────────┤
│            │ SR-0142 · 003-implement            ● running │  CONTROLS    │
│  SIDEBAR   │ aider · openrouter/claude-sonnet-4     [1]   │ ┌──────────┐ │
│            │                                              │ │ ⏸ Pause  │ │
│  RUNS  [2] │  PLAN — TDD step 3 of 9                [3]   │ │ ■ Kill   │ │
│ ● 003-impl │  ✓1 ✓2 ▸3 ○4 ○5 ○6 ○7 ○8 ○9                │ │ ⇄ Handoff│ │
│ ◐ 002-tdd  │                                              │ └──────────┘ │
│ ✓ 001-trg  │  12:41 elapsed                        [4]   │              │
│ ──────────│  in 412k  out 9.2k  cached 380k  $0.41      │  COMMITS     │
│ survey:   │                                              │ a3f9c1 step2 │
│ backend ◐ │  TRANSCRIPT                            [5]   │ 9b2e04 step1 │
│            │  ┌────────────────────────────────────────┐  │      [7]     │
│            │  │ > editing internal/session/store.go …  │  │              │
│            │  │ > test session_expiry … FAIL→pass      │  │   ARTIFACTS  │
│            │  │ > write internal/session/cache.go      │  │ prompt.md    │
│            │  │ ▊ streaming…                    follow ⧉│  │ usage.json   │
│            │  └────────────────────────────────────────┘  │ DEVIATIONS.md│ │
│            │                                          [6] │      [8]     │
└────────────┴──────────────────────────────────────────────┴──────────────┘
```

## Annotations

1. **Run header** — ticket ref + run name (`003-implement`), status
   pill (running ● pulse / paused ◐ / stalled amber / exited),
   backend, model, depth.
2. **Runs rail** — left rail lists recent runs (all subjects, incl.
   non-ticket `survey:`/`probe:` runs) newest-first with status dots;
   filter by workspace. Picking one swaps the whole panel.
3. **Plan progress** — for implement runs: TDD execution-plan steps as
   ✓/▸/○ chips (done / current / pending). Other stages show a
   generic stage label (`drafting…`).
4. **Elapsed + live usage strip** — elapsed time and a live counter:
   tokens in / out / cached + cost (or `~est` flag / `—` when
   non-token-priced). Ticks via `usage_partial` SSE — never a ledger
   event.
5. **Transcript** — streaming log tail (mono, wrapped). Follow-scroll
   toggle; scroll-up breaks follow and shows a "jump to live" pill.
   Redaction-safe: adapter already strips env.
6. **Transcript footer** — stream status + copy / open-raw actions.
7. **Commits feed** — commits the run has produced (sha + message),
   click → diff view (S-08-style renderer, read-only).
8. **Artifacts** — files in `runs/<NNN>-<stage>/`: prompt, usage.json,
   DEVIATIONS.md, outputs; click → raw viewer.

## Controls (right rail)

| Action | Effect | Confirm |
| --- | --- | --- |
| Pause | SIGSTOP — freezes process, preserves state | none |
| Resume | SIGCONT | none |
| Kill | SIGTERM → SIGKILL after grace; worktree + branch preserved | yes — "work preserved in worktree" |
| Hand off to human | stops run, keeps worktree+branch, appends handoff summary to ticket; ticket gets "resume pipeline" affordance | yes |
| Kill (stalled) | for `stalled` runs — same flow, called out as "no heartbeat" | yes |

## Fields

| Element | Source |
| --- | --- |
| Header | `runs` row: id, stage, status, backend, model, depth, pid |
| Usage | `runs.tokens_in/out/cached`, `cost_usd`, `usage_source` |
| Plan | tdd.md execution-plan table (implement runs) |
| Commits | `commit` events / worktree git log |
| Artifacts | `run_dir` listing |

## Interactions

- `k` kill (confirm), `space` pause/resume, `f` toggle follow.
- Stalled runs get an amber banner ("no heartbeat ~2 ticks") with a
  kill shortcut — this is how stuck runs get surfaced per WF-08.
- Run ends → status pill flips, controls disable, artifacts refresh;
  a "next gate" link appears when the conductor surfaced one.

## Style notes

- Transcript is the hero: JetBrains Mono 12px, zinc-400 text on
  zinc-950, tool-lines dimmer than code-lines.
- Status pill semantics shared with S-10/S-05 (same component).
- Dense rails: runs rail 200px, right rail 220px.
