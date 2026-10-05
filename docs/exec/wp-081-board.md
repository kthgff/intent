---
schema: 1
id: wp-081
title: Board home — Kanban + ticket focus page + validated drag-drop
status: done
priority: medium
depth: deep
repos: []
wave: W9
depends_on: [wp-080]
---

## Description

Rehome S-01 per `docs/design/s-01-board.md` (D21): Home becomes two
tabs — **Board** (default) + existing inbox list as tab 2. Board = five
phase columns (Backlog·Spec·Build·Review·Done) collapsing the SCHEMAS
§1 status enum, unified across workspaces with the existing scope
selector. Cards show id/title/priority/sub-status + per-gate_item
attention badges (failure/escalation emphasized — human-anxiety-first).
Failed/blocked render in their last-phase column, red-flagged.

Card → full-page ticket focus view (`/tickets/<ref>/focus`,
sidebar/topbar persist): status stepper, current gate action inline
(embed wizard answer / doc approve / retry), rendered ticket.md,
chat-to-edit, activity rail. Heavy surfaces are linked routes
(S-05/S-07/S-08/S-11), not embeds. (Drawer design rejected 2026-10-03 —
needs full width; see D23.)

Drag-drop: human-meaningful transitions only — →Done = `wont_do`,
failed/blocked self-column drop = `retry`, escalated self-column drop =
`claim`. All drops validated server-side; invalid = reject + animate
back.

API work (conductor-owned, flag before touching): `GET /board`
payload — tickets + derived `phase` (last non-failure status from
`events_idx`) + `attention` + `drop_targets` per card; `POST
/interview` gains optional `ticket_ref` for chat-to-edit.

## File ownership

`packages/ui/**`; `packages/api` additions (`/board`, `/interview`
ticket_ref) flagged — coordinate with conductor ownership.

## Acceptance criteria

- [x] Board renders all tickets in phase columns, unified + workspace
  filter; SSE moves cards/updates badges without refresh
- [x] Attention badges reflect open gate_items; failure/escalation
  badges visually emphasized
- [x] Drag-drop: only `drop_targets` drops enabled; reject animates
  back + toast; successful drop posts action idempotently (expected_status)
- [x] Ticket focus page: stepper + inline gate action (wizard/approve/retry) +
  ticket.md + chat-to-edit + activity; pop-outs to S-07/S-08/S-11
- [x] Chat-to-edit proposes ticket.md diff via interview run; human
  approve → commit + ledger event
- [x] Inbox tab retains snooze/claim/filters; ranking human-anxiety-first
- [x] In-column sort attention-first→priority→age; Done capped ~20 +
  "show more"; ops strip for non-ticket gate items; board snooze hides
  the card until `snoozed_until`
- [x] Empty/error states per column and for empty board

---

## PRD — wp-081: Board home

### Problem / why

The inbox-only home answers "what needs me" but not "where is
everything." Users think in pipeline terms — a Kanban board of tickets
by phase is the natural mental model, and most ticket work should be
clearable from a full-page focus view (D21/D23, product
interview 2026-10-03). The inbox survives as a tab; the board is the
default daily surface.

### Requirements (final)

- Home = two tabs: **Board** (default) + **Inbox** (existing list,
  re-ranked human-anxiety-first). Tab choice persists.
- Board: 5 phase columns — Backlog · Spec · Build · Review · Done —
  per the status mapping in `s-01-board.md`; unified across workspaces
  with the scope selector; per-column counts + configurable per-column
  WIP soft limits (amber when exceeded).
- Cards: id, title, priority, sub-status chip, attention badges per
  open gate_item; failure/escalation badges emphasized; claimer
  initials on claimed badges.
- In-column sort: attention-first → priority → age.
- failed/blocked tickets render in the column of the phase they died
  in, red-flagged (requires derived `phase` in `/board` payload).
- Done capped at ~20 recent cards + "and N more" expander.
- Ops strip above columns for non-ticket gate items (survey/import);
  hidden when empty.
- Snooze on the board hides the card until `snoozed_until`.
- Drag-drop: server-computed `drop_targets` per card; only valid drops
  enabled in UI; invalid drops rejected (409 + animate back + toast).
  v1 actions: →Done = `wont_do`, failed self-drop = `retry`, escalated
  self-drop = `claim`.
- Card → **ticket focus page** at `/tickets/<ref>` (D24: replaces
  S-05). Pinned: phase stepper + Your-move gate panel (current gate
  only). Tabs: Overview · Documents · Activity · Runs + a
  status-conditional spotlight tab — full S-08 embedded when in review
  states, Failure detail when failed, Split plan when proposed.
  Persistent right rail: ticket-scoped AI assistant + key facts +
  surface links.
- Doc versioning: every persisted change to prd/tdd/test = a version;
  per-doc version history + MR-style before/after diffs between any
  two versions.
- Chat assistant: multi-turn, `main_model`, via `POST /interview` +
  `ticket_ref`; edits ticket.md AND the ticket's docs (`target` field
  per SCHEMAS §16); human approve → commit + `doc_edited` event +
  version bump.
- SSE drives card movement, badges, ops strip — no polling.
- "Only my moves" toggle: dims cards with no open gate_items relevant
  to me.

### Acceptance criteria

| ac_id | criterion | verifies-how |
| --- | --- | --- |
| ac1 | Given tickets in every status, when the board loads, then each card appears in the column per the phase mapping and failed/blocked cards render in their last-phase column with a failure flag | unit (phase mapper) + integration (board payload) |
| ac2 | Given a ticket with an open gate_item, when the board renders, then the card shows an attention badge; failure/escalation badges are visually emphasized over question/approval badges | unit + manual |
| ac3 | Given a column containing cards with and without open gate_items, when rendered, then attention cards sort first, then priority, then age | unit |
| ac4 | Given >20 terminal tickets, when the Done column renders, then it shows ≤20 cards and an "and N more" expander that reveals the rest | unit |
| ac5 | Given non-ticket gate items (survey/import subjects), when the board loads, then they appear in the ops strip and not in any column; when none exist the strip is hidden | unit |
| ac6 | Given a card with gate_items snoozed until a future time, when the board renders, then the card is absent; when the snooze expires it returns | integration |
| ac7 | Given a card, when the user drags it onto a column in `drop_targets`, then the corresponding action posts with `expected_status` and the card updates on success; when dropped on an invalid column, then no request fires and the card animates back | unit + e2e |
| ac8 | Given a stale drop (gate cleared by another install), when the action posts, then a 409 surfaces a toast and the board re-syncs | integration |
| ac9 | Given a card click, when the ticket focus page opens at `/tickets/<ref>`, then the phase stepper, gate panel, tabs, AI-assistant rail, and a back link to the board are present | e2e |
| ac9b | Given a ticket in a review status, when the focus page renders, then a Code review spotlight tab appears containing the embedded S-08 surface; given a failed ticket, a Failure tab appears instead | component + e2e |
| ac9c | Given a doc with ≥2 versions, when a version diff is opened, then an MR-style before/after diff renders between the selected versions; every persisted change appears as a version | integration |
| ac9d | Given the Activity tab, when rendered, then it shows the full ledger timeline (events + artifact links), not a digest | integration |
| ac9e | Given a chat instruction targeting tdd.md, when the diff is approved, then a commit + ledger event + new tdd.md version land; chat cannot write outside the ticket's files | integration |
| ac10 | Given a chat-to-edit session on a ticket, when the user sends instructions and approves the final diff, then exactly one commit lands and a ledger event is written; the run uses `main_model` | integration |
| ac11 | Given a running pipeline, when `run_status`/`gate_*` SSE events arrive, then cards move columns and badges update without reload | e2e |
| ac12 | Given the inbox tab, when items include failures and routine questions, then failures/escalations sort above questions (server + client ranking agree) | unit + integration |
| ac13 | Given a per-column WIP limit configured in settings, when a column exceeds it, then its count renders amber | unit |

### Out of scope

- Full keyboard navigation (h/l/j/k/x/c/d) — deferred, follow-up ticket.
- Per-person assignment, per-workspace swimlanes, manual card ordering.
- Live token/cost telemetry on cards (focus page/monitor territory).
- Metrics panels beyond the column-count/WIP strip (S-12 unchanged).
- New run kinds — chat-to-edit reuses interview machinery.

### Open questions

None at approval time.

---

## TDD — wp-081: Board home

### Architecture

Client: `Home` route owns tab state (Board|Inbox) and the `?ticket=`
param. `Board` renders columns from `GET /board` payload — each card
carries `phase`, `attention[]`, `drop_targets[]`, `snoozed_until`.
Drag uses HTML5 DnD with `drop_targets`-driven highlighting; drops map
to existing `POST /tickets/<ref>/actions` (+ claim). `TicketFocus`
reuses TicketDetail's stepper/tab components refactored into shared
components; chat-to-edit is a `ChatEdit` panel hitting `/interview`
with `ticket_ref`. Server: `/board` aggregates `tickets` + open
`gate_items` + derived `phase` (last non-failure status from
`events_idx`) + `drop_targets` (static transition table, conductor is
still authoritative on the write). `/inbox` ranking flips to
human-anxiety-first (failures/escalations group-ordered first).

### Execution plan

| step | description | verify-with |
| --- | --- | --- |
| 1 | Server: `GET /board` payload — phase derivation, attention, drop_targets, snooze filter; anxiety-first `/inbox` re-rank | api unit tests |
| 2 | Server: `POST /interview` accepts `ticket_ref` (chat-to-edit mode) | api unit test |
| 3 | UI: `client.board()` + types; `Home` tab container + `?ticket=` param | unit |
| 4 | UI: `Board` screen — columns, cards, badges, ops strip, Done cap, WIP warnings, snooze-hides, attention-first sort | component tests |
| 5 | UI: drag-drop — drop_targets highlighting, valid drop → action post, invalid/409 → animate back + toast | component + e2e |
| 6 | UI: `TicketFocus` page — pinned gate panel, tabs + spotlight, AI rail; becomes the `/tickets/<ref>` route | component tests |
| 6b | UI: Documents tab — version list + MR-style diff embed (reuse S-06 reviewer) | component tests |
| 7 | UI: `ChatEdit` — multi-turn, diff preview, approve → commit | component + integration |
| 8 | UI: Inbox tab — KIND_ORDER + rankInbox anxiety-first; existing claim/snooze retained | unit |
| 9 | Settings: per-column WIP soft limits | unit |
| 10 | SSE wiring: board refreshes on `run_status`/`gate_*`/`ticket_updated` | e2e |

### File plan

| file | repo | change | why |
| --- | --- | --- | --- |
| packages/api/src/server.ts | intent | modify | `/board` route, `ticket_ref` on `/interview`, anxiety-first `/inbox` |
| packages/core/src/*.ts | intent | modify (flagged — contract types) | BoardCard/drop_targets/attention payload types |
| packages/ui/src/api.ts | intent | modify | `client.board()`, interview `ticket_ref` arg |
| packages/ui/src/screens/Home.tsx | intent | create | tab container + `?ticket=` param |
| packages/ui/src/screens/Board.tsx | intent | create | columns, cards, ops strip, WIP, drag-drop |
| packages/ui/src/screens/TicketFocus.tsx | intent | create | centerpiece page: gate panel, tabs+spotlight, AI rail, doc versions |
| packages/ui/src/screens/Inbox.tsx | intent | modify | becomes tab 2; anxiety-first ordering |
| packages/ui/src/components.tsx | intent | modify | shared stepper/gate-panel extraction for focus-page reuse |
| packages/ui/src/screens/Settings.tsx | intent | modify | per-column WIP limits |
| packages/ui/src/App.tsx | intent | modify | `/` → Home; nav label "Inbox" → "Home" |
| docs/design/s-01-board.md | intent | untestable: design doc | source of truth for behavior |
| docs/API.md | intent | untestable: spec | `/board` + `ticket_ref` documented (done) |

### Risks / open items

- `phase` derivation from `events_idx` for failed/blocked cards — if a
  ticket failed before any `status_changed` event, fall back to
  Backlog; note in implementation.
- Drag-drop on the Tauri webview: verify HTML5 DnD inside the shell;
  fallback = click-to-move context menu (cheap, specced as graceful
  degradation).
- Chat-to-edit multi-turn cost on `main_model` — surface turn count +
  usage in the panel; users can bail without approving.
- Server `drop_targets` table must stay in sync with the state machine
  — single source: derive from the conductor's allowed-transitions,
  never a duplicated UI-side map.

### Addenda

| ts | planned | did | reason |
| --- | --- | --- | --- |
</content>
