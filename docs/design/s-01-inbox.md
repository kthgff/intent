# S-01 — Needs-attention inbox (home)

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base, 32px rows), keyboard-driven, minimal chrome.

Purpose: the daily surface. Every "your move" item across all tickets
repos, grouped by kind, ranked blocking-first → priority → age. Clearing
items here IS the product loop (WF-12).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [All workspaces ▾]            🔔3  ⚙   [1]     │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Inbox                                    9 items  [2]       │
│  SIDEBAR   │  ─────────────────────────────────────────────────────────  │
│            │  [Filter ▾] [All kinds ▾]  ☐ worst-specs first     [3]      │
│  Inbox   9 │                                                             │
│  Tickets   │  ▾ QUESTIONS (3) — agents blocked                    [4]      │
│  Review  2 │   ● 1  SR-0142  "Which cache backend for sessions?"         │
│  Queue   1 │        team-a · P1 · needs-info · 2h · spec ◐62  claimed→K  │
│  Escal.  2 │   ○ 2  SR-0138  "Confirm Persona name in copy?"             │
│  Metrics   │        team-a · P2 · needs-info · 5h                        │
│  KB        │   ○ 3  WEB-77    "SSO provider — Okta or Entra?"            │
│            │        eng-portal · P0 · needs-info · 1d · spec ◑41         │
│  ──────────│                                                             │
│  WORKSPACES│  ▾ APPROVALS (2)                                            │
│  ▾ team-a 6│   ○ 4  SR-0140  PRD v3 ready — "Notification fan-out"      │
│  ▸ eng-p… │        team-a · P1 · prd-review · 3h                         │
│  + Add    │   ○ 5  WEB-81    Split plan — 4 children proposed            │
│            │        eng-portal · P2 · split-plan · 2d                     │
│      [5]   │                                                             │
│            │  ▸ REVIEWS (1)   ▸ FAILURES (2)   ▸ ESCALATIONS (1)  [6]    │
│            │                                                             │
│            │                                              j/k · x · c [7]│
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Top bar** — app mark, `⌘K` command palette, workspace scope
   selector (unified vs single tickets repo), notification bell with
   unread count, settings link to S-02.
2. **Screen header** — title + live count of open items; count ticks via
   SSE, no refresh.
3. **Filter bar** — workspace/kind filters (compose with sidebar scope),
   and the **worst-specs-first** grooming toggle that re-ranks by
   `spec_score` ascending.
4. **Kind group** — collapsible section per `gate_items.kind`:
   question · approval · review · failure · escalation · split-plan ·
   repair. Groups render in blocking order: kinds with
   `blocked_agent = 1` (agent idle waiting) always sort above
   human-step kinds; within a group, priority then `surfaced_at` age.
5. **Sidebar** — primary nav w/ per-route badge counts; workspaces
   section (expandable → S-13) with per-workspace open-item counts;
   "+ Add" → S-02 tickets-repo tab.
6. **Collapsed groups** — one-liner summaries `▸ KIND (n)`; expand
   state persists per session.
7. **Keyboard hint rail** — `j/k` navigate, `Enter` open, `x` snooze,
   `c` claim, `a` accept-all where applicable, `?` shortcut sheet.

## Row anatomy (the item)

```
 ● │ SR-0142 │ "Which cache backend for sessions?"   [kind chip]
   │ team-a · P1 · needs-info · 2h · spec ◐62 · claimed→K
```

- **Leading dot** — filled `●` = agent blocked on this; hollow `○` =
  human-step item. Color: amber blocked, slate otherwise.
- **Ticket id** — mono, links to S-05. Non-ticket subjects show their
  scope icon instead (`survey:…`, `import:…`).
- **Title/summary** — the question text, doc name + version, or failure
  reason, single-line truncated.
- **Kind chip** — small, colored per kind (questions=violet,
  approvals=blue, reviews=green, failures=red, escalations=orange,
  split-plans=cyan, repair=rose).
- **Meta line** — workspace · priority · ticket status · age
  (`surfaced_at` relative) · `spec_score` badge (`◐62`, red<50 /
  amber<75 / green≥75) · `claimed_by` initials if claimed.
- **Hover actions** (right edge, also keyboard): snooze, claim/release,
  open target screen glyph (`→S-04` etc.).

## Fields per group

| Group (kind) | Summary text | Action opens | Row actions |
| --- | --- | --- | --- |
| Questions | question stem | S-04 wizard | claim, snooze, bail menu (force-ready, wont-do) |
| Approvals | doc name + version | S-06 doc review | claim, snooze, quick-approve (confirm modal) |
| Split plans | "N children proposed" | S-06 variant | claim, snooze |
| Reviews | "review ready — diffstat" | S-08 | claim, snooze |
| Failures | stage + reason | S-10 detail | retry, edit+retry, wont-do |
| Escalations | unresolved question count | S-05 | claim, forward, wont-do |
| Repair | "doc parse failed" | S-05 Documents | open file externally, snooze |

## Interactions

- Row click / `Enter` → the screen that clears that kind (per table).
- `x` snooze (menu: 1h / tonight / tomorrow) — item dims, leaves count.
  Lets you defer an item without clearing it. **Spec gap**: `gate_items`
  has no snooze column — work package adds `snoozed_until` + API field.
- `c` claim — initials appear, other installs see it claimed.
- Badge counts = open gate_items only; snoozed excluded.
- Empty state: "Inbox zero — pipeline is moving." + sparkline of
  recently-cleared items. Error state: banner, stale data remains.

## Style notes

- Dark-first (zinc-950 canvas, zinc-900 cards, zinc-100 text);
  accent = single indigo for primary actions.
- Font: Inter 13px; ids/numbers in JetBrains Mono.
- Rows 32px, 1px zinc-800 separators — no card chrome on list rows.
- Priority glyphs: Linear-style `P0` urgent-red through `P3` faded.
- Spec-score badge: half-donut glyph + number, colored by threshold.
