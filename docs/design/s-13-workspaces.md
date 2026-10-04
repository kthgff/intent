# S-13 — Workspace switcher

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: multi tickets-repo management — switch scope, see per-repo
queue pressure, add a workspace (WF-13). Reached from sidebar
workspaces section or the top-bar scope picker.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K                                                     │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Workspaces                                                  │
│  SIDEBAR   │  ────────────────────────────────────────────────────────── │
│            │                                                             │
│  Inbox   9 │  ┌─────────────────┐ ┌─────────────────┐              [1]   │
│  Tickets   │  │ team-a          │ │ eng-portal      │                    │
│  Review  2 │  │ git@gh:org/team │ │ git@gh:org/eng  │                    │
│  Queue   1 │  │ ─────────────── │ │ ─────────────── │                    │
│  Escal.  2 │  │ ?2  ✓1  ✗1  ⚑0 │ │ ?1  ✓0  ✗0  ⚑1 │              [2]    │
│  Metrics   │  │ 14 tickets ·    │ │ 8 tickets ·     │                    │
│  KB        │  │ 3 in-flight     │ │ 1 in-flight     │                    │
│            │  │ pulled 4m ago   │ │ pulled 12m ago  │                    │
│            │  │            Open→│ │            Open→│                    │
│            │  └─────────────────┘ └─────────────────┘                    │
│            │                                                             │
│            │  + Add workspace                                       [3]  │
│            │  ┌──────────────────────────────────────────────────────┐  │
│            │  │ name  [ eng-tools        ]                            │  │
│            │  │ url   [ git@github.com:org/eng-tools-tickets.git ]    │  │
│            │  │                          [Clone & register]           │  │
│            │  └──────────────────────────────────────────────────────┘  │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Card grid** — one card per `tickets_repos` entry, 2-up.
2. **Card** — name, git url (truncated mono), then a **queue-count
   strip**: per-kind open gate items (?questions ✓approvals ✗failures
   ⚑escalations — same glyphs as inbox), ticket count, in-flight run
   count, last-pull time, per-repo config-override dot when
   `.sprint-runner/config.yaml` exists. `Open →` scopes the app to
   that workspace (top-bar picker follows).
3. **Add form** — name + git url → clone + register (writes
   `tickets_repos` config); clone runs as a task → toast.

## Fields

| Element | Source |
| --- | --- |
| Card | `/workspaces`: name, url, per-repo queue counts, ticket count, active runs |
| Pull state | last fetch/push result, `updated_at` |
| Add form | name, url → `tickets_repos` entry |

## Interactions

- Card click / `Open →` = scope switch (top-bar selector syncs).
- `r` re-pull; pull failures show inline error chip.
- Remove is in S-02 Tickets Repos tab (destructive — kept out of
  this screen).

## Style notes

- Cards: zinc-900, generous padding — this is a sparse screen, let it
  breathe vs the dense lists.
- Queue strip glyphs match S-01 exactly (learn-once vocabulary).
