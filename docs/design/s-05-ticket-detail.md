# S-05 — Ticket detail

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: everything about one ticket — the hub every inbox item,
monitor, and queue row links back to. Hosts the status stepper, doc/QA
tabs, the family rail for split tickets, and a right rail holding
whatever action the current gate needs.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [team-a ▾]                    🔔3  ⚙           │
├────────────┬──────────────────────────────────────────────┬──────────────┤
│            │ ← SR-0142  Session cache layer      ◐62  [1] │              │
│  SIDEBAR   │ P1 · standard · aider · [backend][web]       │   GATE       │
│            │                                              │   PANEL      │
│  Inbox   9 │ ●━━●━━●━━○━━○━━○━━○━━○━━○━━○           [2]  │ ┌──────────┐ │
│  Tickets   │ imported…needs-info  now: questions          │ │ 3 quest- │ │
│  Review  2 │                                              │ │ ions open│ │
│  Queue   1 │ [Overview][Documents][Activity][Runs]   [3]  │ │          │ │
│  Escal.  2 │ ───────────────────────────────────────────  │ │[Answer →]│ │
│  Metrics   │                                              │ │[Force rd]│ │
│  KB        │  ## Description                        [4]  │ │[Wont-do ]│ │
│            │  Add a Redis-backed session cache…           │ └──────────┘ │
│            │                                              │      [6]     │
│            │  ## Acceptance criteria                      │              │
│            │  - [ ] ac1 …                                 │  FAMILY  [7] │
│            │  - [ ] ac2 …                                 │ ┌──────────┐ │
│            │                                              │ │ ▲ parent │ │
│            │  ## Triage (round 2)                   [5]  │ │ SR-0140  │ │
│            │  risk: medium — touches auth path            │ │ ├ c1 SR-…│ │
│            │  files: backend/internal/session/*.go        │ │ └ c2 SR-…│ │
│            │  spec_lint: 62 — 'ac3 vague verb'            │ └──────────┘ │
│            │  self-answered (2) ▸                         │              │
└────────────┴──────────────────────────────────────────────┴──────────────┘
```

## Annotations

1. **Header** — back link, ticket id (mono), title, spec-score badge,
   then a meta line: priority · depth · backend/model · repo chips ·
   `forced` flag if a human overrode a gate · `blocked_reason` when
   blocked.
2. **Status stepper** — horizontal pipeline: imported → triage →
   needs-info → prd → design-qa → tdd → test → in-progress → review →
   approved → pr-open → merged. Compact: filled dots + connecting
   line, current stage labeled. Terminal/off-path statuses
   (failed, blocked, escalated, wont-do) render as a red/amber badge
   overlaid at current position.
3. **Tabs** — Overview | Documents | Activity | Runs.
4. **Overview** — rendered ticket.md body (Description, AC checklist,
   DoD) + frontmatter summary card.
5. **Triage panel** (Overview, below body) — `risk_summary`,
   `files_likely_touched` (repo:path chips), `suggestions` diff vs
   applied values, `spec_lint` score + flags, `self_answered`
   collapsible, `entities_referenced` links into S-14.
6. **Gate panel (right rail)** — the ONE action this status needs:
   questions → answer button + count; doc-review → open reviewer;
   test-approved → **"go" spend checkpoint** w/ cost estimate;
   approved → open PR; failed → retry menu. Nothing when no gate is
   pending — rail collapses.
7. **Family rail** — only for split families: parent link + children
   list w/ per-child status dot, and a mini `depends_on` DAG
   (vertical topo-sorted chips with arrows, not a real graph lib —
   families are ≤5 per `split_max_children`).

## Tabs

| Tab | Contents |
| --- | --- |
| Overview | ticket.md rendered, frontmatter card, triage panel, handoff summary (if `handoff` event — who took it, when, resume button) |
| Documents | list: prd / tdd / test — each row: name, version, status badge (draft/review/approved), last edited, **view → S-06**, version-diff dropdown (v1↔v2 …) |
| Activity | events.jsonl timeline — ts, stage, actor chip (agent/human/runner), event, +cost/tokens on run events; filter by stage/actor; entry → artifact ref → S-11 |
| Runs | table per run: name (`003-implement`), stage, status, backend/model, duration, tokens in/out/cached, cost (or `~` estimated flag), worktree → open S-07 live or S-11 artifacts |

## Interactions

- Stepper is live (SSE `run_status`); current stage pulses.
- Gate panel actions are idempotent (`expected_status` on POST).
- `e` edit ticket.md in markdown editor (frontmatter-aware, schema
  linted on save — malformed → repair gate item).
- Right rail stacks under content <1200px.

## Style notes

- Three-column: sidebar / fluid content / 280px rail.
- Stepper: 8px dots, zinc-700 line, indigo fill for done, pulse on
  current.
- Tab content max-width ~860px for readable prose.
