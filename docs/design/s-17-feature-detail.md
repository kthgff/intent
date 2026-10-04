# S-17 — Feature detail

Design doc companion to `UI-INVENTORY.md` §2 + `FEATURES.md` §1.
Status: draft 2026-10-04. Stack: React+Vite · Tailwind · shadcn/ui.
Style: Linear-inspired — dark-first, dense, minimal chrome.
Anatomy: deliberate S-05 clone — a feature IS a parent subject with
a docs contract; same layout, different entity.

Purpose: everything about one feature — the delivery unit between
initiative and tickets (WF-20). Tracks its tickets, owns its
test plan + AC slice, carries its own gates.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [myApp ▾]                    🔔3  ⚙           │
├────────────┬──────────────────────────────────────────────┬──────────────┤
│            │ ← IN-7 › FE-3  Saved payment methods  P1  [1] │              │
│  SIDEBAR   │ initiative: Billing overhaul · board: Q1     │   GATE       │
│            │                                              │   PANEL      │
│  Inbox   9 │ ●━━●━━○━━○━━○━━○                      [2]  │ ┌──────────┐ │
│  Boards  2 │ decompose  test-review  tickets→merged      │ │ test.md  │ │
│  Tickets   │                                              │ │ ready v2 │ │
│  Features  │ [Overview][Docs][Tickets][Activity][Runs][3] │ │          │ │
│  Review  2 │ ───────────────────────────────────────────  │ │[Review →]│ │
│  Queue   1 │                                              │ │[Approve ]│ │
│  Metrics   │  ## AC slice (from IN-7 PRD)          [4]   │ └──────────┘ │
│  KB        │  ac1 ✓ tokenized storage — covered by c1,c4  │      [6]     │
│            │  ac2 ✓ PCI scope unchanged — manual attest   │              │
│            │                                              │  PARENTS     │
│            │  ## Coverage                          [5]   │ IN-7 Billing │
│            │  5/7 cases mapped · 2 unmapped file-rows     │ ──────────── │
│            │                                              │  SIBLINGS    │
│            │                                              │ FE-2 Auth ▸  │
│            │                                              │ FE-4 Refunds │
│            │                                              │      [7]     │
└────────────┴──────────────────────────────────────────────┴──────────────┘
```

## Annotations

1. **Header** — breadcrumb `IN-7 › FE-3`, title, priority, initiative
   link, board link (the board that birthed the initiative).
2. **Feature stepper** — feature lifecycle: decomposed → spec'd
   (test-review) → tickets flowing → all tickets merged → `delivered`.
   Compact — features don't re-run triage stages.
3. **Tabs** — Overview | Docs | Tickets | Activity | Runs.
4. **AC slice** — the feature's share of initiative ACs with
   per-AC coverage status (test case ids, attest state); provenance
   hover → the board items that grounded each AC.
5. **Coverage summary** — test-plan matrix status at a glance;
   unmapped rows flagged (lint state).
6. **Gate panel** — current feature gate: test-plan review (→S-06),
   split-plan approval, or nothing (rail collapses).
7. **Parents/siblings rail** — initiative card + sibling features
   with status dots — the family rail pattern, one level up.

## Tabs

| Tab | Contents |
| --- | --- |
| Overview | feature.md body, AC slice, coverage summary, trust-inheritance badge ("context pre-approved via IN-7 PRD") |
| Docs | feature.md + test.md rows: version, status badge, view→S-06, version diffs |
| Tickets | child table: id, title, status, priority, runs — progress rollup bar (% merged); orphan-add action (attach existing ticket) |
| Activity | feature-scoped events timeline (same renderer as S-05) |
| Runs | decompose/testplan run rows → S-07 |

## Fields

| Element | Source |
| --- | --- |
| Header | `features` projection (id, title, status, priority, initiative) |
| AC slice | initiative `provenance.json` + feature AC assignment |
| Tickets | `tickets` where `feature = FE-3` |
| Gate | `gate_items` subject `feature:FE-3` |

## Interactions

- Approve test plan inline (plan-package default — combined doc gate).
- **Feature decompose** button when no children yet → split-plan of
  tickets → approve → materialize.
- Batch-approve children split-plans from the gate panel.

## Style notes

- Literal S-05 layout components (stepper, tabs, right rail, family
  rail) — parametrize the shared component, don't fork.
- Breadcrumb trail `project › IN-x › FE-y` is the orientation device
  for the three-level tree.
