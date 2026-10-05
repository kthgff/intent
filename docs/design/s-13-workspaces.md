# S-13 — Project switcher

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03;
revised 2026-10-04 — **renamed "workspace" → "project"** (D26): the
project is the merged workspace+product entity (`workspace` stays the
internal key). Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style:
Linear-inspired — dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: multi-project management — switch scope, see per-project
queue pressure, add a project (WF-13). Reached from sidebar projects
section or the top-bar scope picker. A project owns its tickets scope,
code repos, boards, and dossier — the card shows all four.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K                                                     │
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
│            │  + Add project                                       [3]  │
│            │  ┌──────────────────────────────────────────────────────┐  │
│            │  │ name  [ eng-tools        ]                            │  │
│            │  │ url   [ git@github.com:org/eng-tools-tickets.git ]    │  │
│            │  │                          [Clone & register]           │  │
│            │  └──────────────────────────────────────────────────────┘  │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Card grid** — one card per project, 2-up.
2. **Card** — name, scope (`DB-only` chip — projects are Postgres
   rows, D29), then a **queue-count strip**: per-kind open
   gate items (?questions ✓approvals ✗failures ⚑escalations — same
   glyphs as inbox), ticket count, **board count** (S-15 link),
   in-flight run count, last-sync time, per-project config-override dot
   when `.veto/config.yaml` exists. `Open →` scopes the app to
   that project (top-bar picker follows).
3. **Add form** — name + code-repo paths → `projects` row created;
   probe run queued for each repo.

## Fields

| Element | Source |
| --- | --- |
| Card | `/workspaces` (project list): name, scope, per-project queue counts, ticket + board counts, active runs |
| Sync state | last fetch/push result (legacy) or last DB sync, `updated_at` |
| Add form | name, scope → project entry |

## Interactions

- Card click / `Open →` = scope switch (top-bar selector syncs).
- `r` re-sync; failures show inline error chip.
- Remove is in S-02 Projects tab (destructive — kept out of
  this screen).

## Style notes

- Cards: zinc-900, generous padding — this is a sparse screen, let it
  breathe vs the dense lists.
- Queue strip glyphs match S-01 exactly (learn-once vocabulary).
