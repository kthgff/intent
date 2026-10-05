# S-01 — Home: Board + Inbox tabs

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03
(supersedes the inbox-only S-01; see D21 in TRACKER.md).
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: the daily surface is a **Kanban board**. The product's home
answers "where is every ticket and what's left to do" — the
needs-attention list survives as the second tab (`s-01-inbox.md`).
Board is the default tab; tab choice persists per user/session.

**Board vocabulary (D21 + D26):** this is the **pipeline board** — the
project-wide delivery surface. It is NOT the idea board (S-16): the
idea board is the capture/synthesis surface upstream; the pipeline
board is the Jira-style kanban downstream. They share the same kanban
component — S-16's delivery view is this board scoped by an idea
board's saved filter.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K      [All projects ▾]            🔔3  ⚙   [1]     │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Home          [ Board | Inbox ]                   [2]       │
│  SIDEBAR   │  ─────────────────────────────────────────────────────────  │
│            │  6 backlog · 4 spec · 3 build · 2 review · WIP ok  [3]      │
│  Home    9 │  ⚙ Ops: survey:web-app ready · import:GH-42 pending  [3b]   │
│  Tickets   │  ┌BACKLOG─┐ ┌SPEC───┐ ┌BUILD──┐ ┌REVIEW─┐ ┌DONE──┐  [4]    │
│  Queue   1 │  │        │ │       │ │       │ │       │ │      │         │
│  Escal.  2 │  │ SR-142 │ │SR-140 │ │SR-133 │ │WEB-81 │ │SR-120│         │
│  Metrics   │  │ ⚠ Q&A  │ │ PRDv3 │ │ impl  │ │ PR ✓✗ │ │ mrgd │         │
│  KB        │  │ P1 ·2h │ │  ⚑appr│ │ ▶run  │ │       │ │      │         │
│            │  │        │ │       │ │       │ │       │ │      │         │
│  ──────────│  │ WEB-77 │ │SR-138 │ │WEB-70 │ │       │ │      │         │
│  WORKSPACES│  │ ✗failed│ │       │ │ 🔴fail│ │       │ │      │         │
│  ▾ team-a 6│  │        │ │       │ │(flagged, stays in-phase) │         │
│  ▸ eng-p… │  └────────┘ └───────┘ └───────┘ └───────┘ └──────┘         │
│  + Add     │                                                             │
│      [5]   │                     card click → full page        [6]       │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Top bar** — unchanged from inbox design: app mark, `⌘K`, project
   scope selector (unified vs single project), bell, settings.
2. **Home tabs** — `Board` (default) and `Inbox`. The inbox tab renders
   the S-01 list view unchanged except ranking (see below). Per-user
   last-tab persistence.
3. **KPI strip** — per-column counts + WIP health only. WIP warnings are
   **configurable per-column soft limits** (S-02 settings; amber count
   when exceeded). Anything deeper (velocity, cost, funnel) lives in
   S-12 metrics — the board is a work surface, not a report.
   **3b. Ops strip** — non-ticket gate items (survey/import) as chips;
   hidden when empty.
4. **Board** — five phase columns collapsing the ~28-value status enum
   (SCHEMAS §1). Unified across projects; `All projects ▾` filters
   to one. Column order = pipeline order.

   | Column | Statuses |
   | --- | --- |
   | **Backlog** | imported, triage, needs-info, escalated |
   | **Spec** | prd-draft, prd-review, prd-approved, design-qa, tdd-draft, tdd-review, tdd-approved, test-draft, test-review, test-approved |
   | **Build** | ready, in-progress, review, changes-requested |
   | **Review** | approved, pr-open, ci-watch |
   | **Done** | merged, reverted, wont-do, aborted, split |

   `failed`/`blocked` are not columns — a failed/blocked ticket renders
   **in the phase it died in**, red-flagged, so the board shows where
   work died. The `/board` payload carries a derived `phase` per ticket
   (last non-failure status from `events_idx` — API.md).

   **Done is capped** — shows the ~20 most recent terminal cards with a
   collapsed "and N more" footer; older history lives in the ledger
   (S-11), not the board.

   **Initiatives & features** (FEATURES.md) ride the same columns —
   an initiative renders in Spec while its docs gate, features track
   Build/Review via child rollup. Entity kind is a card prefix chip
   (`IN-`/`FE-`/`SR-` ids already carry it); initiative cards show a
   child-progress bar (n/m features delivered).

   **In-column order** — attention-first: cards with open "your move"
   badges float to top (failure/escalation badges loudest), then
   priority → age.

   **Non-ticket items** (survey/import subjects) — a slim **utility
   strip** above the columns (`⚙ Ops: survey:web-app ready ·
   import:GH-42 pending`); chips deep-link. Board columns stay
   ticket-only — ops items aren't pipeline tickets and get no fake
   column.

5. **Sidebar** — nav + badge counts, plus **Boards** and **Features**
   entries (D26); projects section, "+ Add".
   Badge counts source = open `gate_items` (snoozed excluded), same as
   before — badges now also feed card attention signals.

6. **Card → full page** — clicking a card navigates to a dedicated
   ticket focus page (sidebar/topbar persist; see "Ticket focus page"
   below). Revised 2026-10-03: a slide-out drawer was designed first
   and rejected — the gate action + chat-to-edit need full width.

## Card anatomy

```
 SR-0142  Which cache backend for sessions?      ⚠ [kind]
 team-a · P1 · needs-info · 2h · sub-status chip
```

- **Id + title** — mono id, card navigates to the focus page; title
  2-line clamp.
- **Sub-status chip** — the raw status within its phase
  (`prd-review`, `ci-watch`, …) — columns are coarse, the chip is precise.
- **Attention badge** — one per open `gate_item` on the ticket, colored
  by kind (same palette as inbox chips). Badge emphasis is
  **human-anxiety-first**: failure/escalation badges render louder
  (solid, red/orange) than routine Q&A/approval badges (outline).
  Claimed items show claimer initials on the badge (`claimed→K` style);
  the "only my moves" toggle filters to unclaimed + my claims.
- **Meta line** — project · priority · age in column.
- Not on the card (deliberate): spec-score, live token counters —
  focus-page/monitor territory. Cards stay scannable.

## Drag & drop — validated, human-meaningful only

Cards are draggable, but the board is not a status editor: forward
pipeline transitions are owned by the conductor and are **always
rejected**. Permitted drops at v1:

| Drop | Maps to API action | Confirm |
| --- | --- | --- |
| any open card → **Done** | `wont_do` (or `aborted` for in-flight) | modal |
| failed/blocked card → its own column | `retry` (optionally stronger model) | modal |
| escalated card → its own column | `claim` | none |

- Server is authoritative: the board payload carries `drop_targets`
  per card (derived from allowed transitions); the UI highlights only
  valid columns during drag. On `409`/reject the card animates back
  and a toast explains why. `/board` carries `drop_targets` per card
  (API.md); no new transition logic in the UI.
- A rejected drop is a feature, not an error state — the cursor/target
  styling communicates invalidity before release.

## Ticket focus page (replaces the drawer — and S-05)

Card click navigates to the **ticket focus page** — the centerpiece
surface, which **replaces S-05 entirely** (`/tickets/<ref>` routes to
it). Spec lives in [`s-05-ticket-focus.md`](s-05-ticket-focus.md);
summary: inline Next action + workbench tabs
(Overview/Documentation/Activity/Runs + status-conditional spotlight —
full S-08 embedded in review, Failure detail when failed), a narrow
Status/What's-left rail, and contextual AI only while editing ticket.md,
documentation, or code-review objects. Every persisted doc change is
versioned with MR-style diffs.

## Ranking (changed — D21)

The needs-attention ordering is now **human-anxiety-first**: failures
and escalations rank above routine agent Q&A/approvals — a broken
thing matters more than an idle agent. Applies to the inbox tab list
AND to attention-badge emphasis on cards. This reverses the earlier
blocking-first rule (superseded 2026-10-03); within a class,
priority → age still applies.

## Interactions

- Card click / `Enter` → ticket focus page. **Full keyboard nav
  (h/l columns, j/k cards, x/c/d) is deferred** — mouse-first v1;
  follow-up ticket.
- Live updates via SSE (`run_status`, `gate_surfaced`/`gate_cleared`,
  `ticket_updated`): cards move columns and badges appear without
  refresh — the board feels alive during overnight runs.
- Filters: project (top bar), kind filter, "only my moves" toggle
  (dims cards with no open gate_items).
- **Snooze on the board hides the card** — stronger than the inbox tab
  (where snoozed items dim but stay listed): a snoozed ticket's card
  leaves the board until `snoozed_until`, then returns. Snoozed cards
  are still excluded from badge counts (same `gate_items` field).
- Empty state per column; board-level empty = "import tickets to
  start" + create/import CTA.

## Style notes

- Same dual-theme (dark + light, D34) zinc palette; accent indigo for primary actions.
- Column headers: 11px uppercase label + count; WIP warning in amber
  when a column exceeds a configurable soft limit.
- Cards: zinc-900, 1px zinc-800 border, 8px radius; failed/blocked
  cards get a red left-edge bar, not a recolor.
- Drag: valid target columns get a subtle accent outline; invalid
  targets stay muted with `not-allowed` cursor.
- Density: card min-height ~64px; column width ~280px, horizontal
  scroll below 1400px viewport.
</content>
