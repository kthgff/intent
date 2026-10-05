# S-11 — Ledger browser

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: full transaction history per ticket (WF-10) — the event
timeline, per-run artifact tree, prompt/transcript/outputs inspection,
version replay. Read-only audit surface; nothing here writes.

**Revised (D26/D29):** the timeline reads the append-only `events`
table (same event schema — one row per event, immutable; there is no
events.jsonl). Ledger scope extends to
initiatives, features, and boards — the filter rail gains an entity
kind, so `IN-7` shows every event across its children.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K                                                     │
├────────────┬───────────────────────────┬─────────────────────────────────┤
│            │ ← SR-0142  Ledger          [stage ▾][actor ▾]          [1] │
│  SIDEBAR   │ ─────────────────────────────────────────────────────────── │
│            │  EVENTS                                  │                 │
│  Inbox   9 │  14:22:10  review    agent   finding_created      [2]      │
│  Tickets   │  14:01:03  review    runner  run_finished  $0.12 41k/4k   │
│  Review  2 │  13:55:00  review    runner  run_started   002-review      │
│  Queue   1 │  13:40:11  implement agent   commit        a3f9c1         │
│  Escal.  2 │  13:12:44  triage    human   question_answered  q3         │
│  Metrics   │  12:58:01  triage    agent   question_asked      [3]       │
│  KB        │  ─ selected ──────────────────────────────────            │
│            │                                              │  DETAIL      │
│            │                                              │  event       │
│            │                                              │  ┌─────────┐ │
│            │                                              │  │ json    │ │
│            │                                              │  │ refs →  │ │
│            │                                              │  └─────────┘ │
│            │                                              │  run 003-impl│
│            │                                              │  ┌─────────┐ │
│            │                                              │  │artifacts│ │
│            │                                              │  │ prompt  │ │
│            │                                              │  │ transcr │ │
│            │                                              │  │ usage.j │ │
│            │                                              │  │ DEVIATI │ │
│            │                                              │  └─────────┘ │
│            │                                              │      [4]     │
└────────────┴───────────────────────────┴─────────────────────────────────┘
```

## Annotations

1. **Filters** — stage, actor (agent/human/runner/system), event kind,
   time range; ticket picker top (also reachable per-ticket from
   S-05 → Activity → "open in ledger").
2. **Event timeline** — one line per event row: ts, stage
   chip, actor-type chip (agent indigo / human green / runner gray /
   system zinc), event name, +inline numbers on run events
   (`$cost`, `tokens in/out`, `duration`, `~est` flag for estimated).
   Newest-first, virtualized.
3. **Refs** — `refs[]` artifact paths render as links opening the
   artifact in the detail pane.
4. **Detail pane** — two stacked cards:
   - **Event detail**: pretty-printed `data` json, run link, commit
     sha links.
   - **Run artifacts**: files under `runs/<NNN>-<stage>/` — prompt.md,
     transcript, usage.json (renders the per-call table), review.json,
     DEVIATIONS.md, test-report.json. Click → raw/structured viewer
     bottom sheet. Compare-mode: pick any two `usage.json` /
     doc versions → diff.

## Fields (`events` table per SCHEMAS §7)

`ts` · `ticket` · `stage` · `actor.type/id` · `event` · `run` ·
`refs[]` · `cost_usd` · `tokens_in/out/cached` · `usage_source` ·
`duration_s` · `human_minutes`

Plus rollup strip when a ticket is selected: totals per stage
(tokens in/out/cached, cost where computable, est flags) — the
per-ticket token ledger.

## Interactions

- `j/k` move selection, `Enter` open detail, `/` focus filter.
- Replay any stage = deep-link to the corresponding run in S-07
  (finished runs show stored transcript, not live stream).
- Export: copy event json / download artifact.

## Style notes

- Three-pane: timeline (fluid) + detail (340px).
- Timeline rows 26px — densest list in the app; mono ts.
- Actor chips colored consistently app-wide.
- Json viewer: collapsible tree, zinc syntax palette.
