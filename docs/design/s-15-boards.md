# S-15 — Boards list

Design doc companion to `UI-INVENTORY.md` §2 + `FEATURES.md` §2.
Status: draft 2026-10-04. Stack: React+Vite · Tailwind · shadcn/ui.
Style: Linear-inspired — dark-first, dense, minimal chrome.

Purpose: named idea boards per **project** (many per project —
"Q1 goals", "bug wishes"). Entry to the idea space (WF-18) and the
synthesis launch point.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [myApp ▾]                     🔔3  ⚙           │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Boards · myApp                                             │
│  SIDEBAR   │  ────────────────────────────────────────────────────────── │
│            │                                                             │
│  Inbox   9 │  ┌─────────────────┐ ┌─────────────────┐              [1]   │
│  Boards  2 │  │ Q1 goals        │ │ Bug wishes      │                    │
│  Tickets   │  │ 23 items        │ │ 7 items         │                    │
│  Features  │  │ ●14 consumed    │ │ ●2 consumed     │              [2]   │
│  Review  2 │  │ ⚑ 9 open        │ │ ⚑ 5 open        │                    │
│  Queue   1 │  │ ─────────────── │ │ ─────────────── │                    │
│  Metrics   │  │ last synth:     │ │ never synth'ed  │                    │
│  KB        │  │ IN-7 "Billing"  │ │                 │                    │
│            │  │ filter: IN-7 +  │ │ filter: project │              [3]   │
│            │  │ orphans         │ │ (all work)      │                    │
│            │  │            Open→│ │            Open→│                    │
│            │  └─────────────────┘ └─────────────────┘                    │
│            │  ┌─────────────────┐                                         │
│            │  │ + New board     │                                         │
│            │  │ name [      ]   │                                         │
│            │  │        [Create] │                                         │
│            │  └─────────────────┘                                         │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Board card grid** — one card per board, 2-up; sparse layout.
2. **Card contents** — name, total items, consumed (● indigo) vs open
   (⚑ amber) split, last synthesis (initiative ref + when),
   filter summary, archived dimmed.
3. **Filter summary** — one-line human render of the board's saved
   work-layer filter ("IN-7 + orphans", "all project work").
4. **+ New board** — inline create: name → empty canvas. Archive
   lives in a `⋯` menu (confirm; archived boards keep items, hide
   from nav count).

## Fields

| Element | Source |
| --- | --- |
| Card | `boards` row + `board_items` counts by status |
| Filter summary | `boards.filter_config` rendered |
| Last synthesis | latest `board-synthesize` run ref → initiative |

## Interactions

- Click card / `Enter` → S-16 canvas.
- Sidebar Boards nav badge = total open items across boards in the
  scoped project.
- Icebox count excluded from "open" badge.

## Style notes

- Same card-grid anatomy as S-13 (workspace switcher) — learn-once
  pattern for "pick a container" screens.
- Sticky-note yellow accent reserved for board iconography only.
