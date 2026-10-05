# S-01 — Needs-attention inbox (Home tab 2)

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03;
revised 2026-10-03 — **the inbox is now a tab on Home, not the home
screen** (D21). The default home view is the Kanban board — see
`s-01-board.md`. Stack: React+Vite · Tailwind · shadcn/ui (Radix).
Style: Linear-inspired — dual-theme (dark + light, D34), dense (13px base, 32px rows),
keyboard-driven, minimal chrome.

Purpose: the action list. Every "your move" item across all tickets
repos, grouped by kind, ranked **human-anxiety-first** → priority → age
(failures/escalations outrank routine agent Q&A — D21 supersedes the
earlier blocking-first rule). Clearing items here IS the product loop
(WF-12); the board answers "where is everything", this tab answers
"what's on fire / what needs me".

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K      [All projects ▾]            🔔3  ⚙   [1]     │
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

1. **Top bar** — app mark, `⌘K` command palette, project scope
   selector (unified vs single project), notification bell with
   unread count, settings link to S-02.
2. **Screen header** — title + live count of open items; count ticks via
   SSE, no refresh.
3. **Filter bar** — project/kind filters (compose with sidebar scope),
   and the **worst-specs-first** grooming toggle that re-ranks by
   `spec_score` ascending.
4. **Kind group** — collapsible section per `gate_items.kind`:
   question · approval · review · failure · escalation · split-plan ·
   repair, **plus initiative/feature kinds** (D26):
   `initiative-doc-review` · `feature-test-review` · `batch-approve`
   · `verify-confirm` · `board-digest` (D27).
   Groups render **human-anxiety-first** (D21): failures and
   escalations sort above routine questions/approvals; within a group,
   priority then `surfaced_at` age. **Initiative grouping:** items
   belonging to one initiative cluster under a collapsible
   `IN-7 "Billing" — 4 gates` sub-header inside their kind group, so
   the gate cost of an initiative stays visible (FEATURES.md §4).
5. **Sidebar** — primary nav w/ per-route badge counts; **Boards** and
   **Features** entries (per-project badge = open items); **projects**
   section (expandable → S-13) with per-project open-item counts;
   "+ Add" → S-02 project tab.
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
- **Meta line** — project · priority · ticket status · age
  (`surfaced_at` relative) · `spec_score` badge (`◐62`, red<50 /
  amber<75 / green≥75) · `claimed_by` initials if claimed.
- **Hover actions** (right edge, also keyboard): snooze, claim/release,
  open target screen glyph (`→S-04` etc.).

## Fields per group

| Group (kind) | Summary text | Action opens | Row actions |
| --- | --- | --- | --- |
| Questions | question stem | S-04 wizard | claim, snooze, bail menu (force-ready, wont-do) |
| Approvals | doc name + version | S-06 doc review | claim, snooze, quick-approve (confirm modal) |
| Initiative docs | "IN-7 PRD v1 ready" | S-06 (initiative variant) | claim, snooze, quick-approve |
| Feature tests | "FE-3 test plan ready" | S-06 | claim, snooze |
| Batch approvals | "5 feature test plans" | S-06 plan-package | **approve all** (confirm lists subjects), claim, snooze |
| Split plans | "N children proposed" | S-06 variant | claim, snooze |
| Reviews | "review ready — diffstat" | S-08 | claim, snooze |
| Failures | stage + reason | S-10 detail | retry, edit+retry, wont-do |
| Escalations | unresolved question count | S-05 | claim, forward, wont-do |
| Repair | "doc parse failed" | S-05 Documents | open file externally, snooze |
| Board suggestions | "3 notes look like IN-7" | S-16 | accept → board, dismiss |
| Verify confirms | "FE-3 merged — confirm live" | S-05 verify | confirm released, mark failed |
| Board digests | "14 items stale 60d" | S-16 | synthesize / icebox / keep |

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

- Dual-theme (D34 — see docs/design/theming.md);
  accent = single indigo for primary actions.
- Font: Inter 13px; ids/numbers in JetBrains Mono.
- Rows 32px, 1px zinc-800 separators — no card chrome on list rows.
- Priority glyphs: Linear-style `P0` urgent-red through `P3` faded.
- Spec-score badge: half-donut glyph + number, colored by threshold.
