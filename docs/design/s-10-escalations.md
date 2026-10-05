# S-10 — Escalations & failures queue

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: everything broken or returned to a human (WF-08, WF-09) —
failed runs, blocked tickets, escalations, aborts, doc-repair items.
Each row carries enough context to act without opening the ticket.
Subjects now span the full entity tree (D26) — a failed
`board-synthesize`, `initiative-decompose`, or `feature-decompose` run
lands here too, kind-prefixed (`IN-7` / `FE-3`), same actions.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K      [All projects ▾]            🔔3  ⚙           │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Queue                                              [1]     │
│  SIDEBAR   │  ────────────────────────────────────────────────────────── │
│            │  [All 6] [Failed 2] [Blocked 1] [Escalated 2] [Repair 1][2] │
│  Inbox   9 │                                                             │
│  Tickets   │  ┌──────────────────────────────────────────────────────┐  │
│  Review  2 │  │ ✗ SR-0139  FAILED · implement · 40m ago        [3]  │  │
│  Queue   1 │  │   backend · P1 · agent-failure: context overflow     │  │
│  Escal.  2 │  │   ▸ log tail  "…error: token limit at step 7/9"  [4]│  │
│  Metrics   │  │   [Retry] [Retry w/ escalation model] [Edit+retry]   │  │
│  KB        │  │   [Wont-do] [Claim]                              [5]│  │
│            │  ├──────────────────────────────────────────────────────┤  │
│            │  │ ⚑ WEB-77   ESCALATED · triage · 1d                    │  │
│            │  │   2 unresolved questions — "SSO provider?"           │  │
│            │  │   [Claim & answer →] [Forward to author] [Wont-do]   │  │
│            │  ├──────────────────────────────────────────────────────┤  │
│            │  │ ⚠ SR-0140  BLOCKED · env — worktree probe failed     │  │
│            │  │   `gitleaks: command not found`             claim→K  │  │
│            │  │   [Fix env (open docs)] [Retry] [Wont-do]            │  │
│            │  └──────────────────────────────────────────────────────┘  │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Header** — queue title + open count; project filter from top bar.
2. **Kind chips** — filter tabs: All · Failed · Blocked · Escalated ·
   Aborted · Repair (doc-repair). Counts live.
3. **Row header** — status glyph + ticket ref + kind + stage where it
   died + age. Status glyphs: ✗ failed (red), ⚠ blocked (amber),
   ⚑ escalated (orange), ⏹ aborted (gray), ⚒ repair (rose).
4. **Context block** — one-line classification
   (`env | agent | <text>` from `blocked_reason` / failure sentinel)
   + expandable **log tail** (last ~20 lines of the run log, mono).
   Escalations show the unresolved-question list instead.
5. **Action bar** — contextual per kind (table below); `claimed→K`
   suffix when someone holds it.

## Actions per kind

| Kind | Actions |
| --- | --- |
| failed | Retry (same model) · Retry w/ `escalation_model` · Edit ticket + retry (opens ticket.md editor → re-triage) · Wont-do · Claim |
| blocked | env fix hint (e.g. missing binary → docs link) · Retry · Wont-do |
| escalated | Claim & answer → (opens S-04 wizard with the unresolved questions) · Forward to author (copies a markdown question block for external reply) · Wont-do |
| aborted | Retry · Wont-do (informational — killed by human or timeout) |
| repair | Open broken doc (external editor hint) · mark-repaired → re-lint · Open on github.com |
| stalled run | Kill (from run row). Renders via `notifications`, not a `gate_items` row — so no claim semantics; the row links straight to S-07 and disappears when the run is killed or heartbeats again |

## Fields

| Element | Source |
| --- | --- |
| Row | `tickets` projection (status, blocked_reason, priority, workspace) + failed `runs` row (stage, sentinel, exited_at) |
| Log tail | `run_dir` log file tail |
| Escalation | `triage.json` open questions |

## Interactions

- Retry menu shows attempt history ("attempt 2 of 3 — last failed
  on tokens") — retry ladder visible.
- Edit+retry opens the markdown editor inline (drawer) then commits
  and re-triages.
- Claim before acting on shared queue; claim state visible inline.

## Style notes

- Rows are zinc-900 cards (not flat rows like inbox) — each is a
  self-contained case file.
- Log tail: mono 11px, max 5 lines, click expands to 20.
- Action bar: quiet buttons (zinc-800) except retry = indigo.
