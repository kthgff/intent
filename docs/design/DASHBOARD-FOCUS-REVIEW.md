# Dashboard and ticket-focus review

Status: implementation-ready design synthesis, 2026-10-04. This document
summarizes the product review behind S-01 and S-05; the detailed interaction
contracts remain [`s-01-board.md`](s-01-board.md) and
[`s-05-ticket-focus.md`](s-05-ticket-focus.md).

## Product and UX review

Veto is a governance layer for agent-authored work. Its primary operator is an
engineer or technical product owner who wants the pipeline to keep moving while
retaining judgment at the consequential gates. The durable product record lives
in Git; the database coordinates live runs, claims, projections, and attention.

The home screen therefore should not be an analytics dashboard. Its first job is
to answer **where every ticket is and what needs a human now**. A five-phase
Kanban is the best primary representation because the underlying state machine
has many precise statuses, but people scan work in the coarser phases Backlog,
Spec, Build, Review, and Done. The existing needs-attention inbox remains the
second Home tab for operators who want a strict action queue.

A card click opens a full-page Ticket Focus surface. A drawer was rejected: the
current action, versioned documents, ledger, and status-specific review/failure
surfaces need more width and a stable URL. The sidebar and context bar remain
visible, so the transition feels like drilling into the board rather than
leaving it. AI appears inside ticket/document/review editing only, not as a
permanent column.

## Requirements matrix

| Concern | Dashboard requirement | Ticket-focus requirement | Why it matters |
| --- | --- | --- | --- |
| Primary purpose | Show every ticket by phase and emphasize human attention | Explain and clear the selected ticket's current gate | Separates scanning from focused decision-making |
| Default view | Board tab; Inbox remains tab 2 | Overview tab plus conditional spotlight tab | Matches the product's pipeline mental model |
| Ordering | Attention first, then priority, then age | Current gate remains pinned above other content | Broken or blocked work cannot disappear in chronology |
| Identity | Ticket ID, short title, workspace | ID, complete title, workspace, priority, exact status | Maintains continuity from card to object |
| State | Phase column plus precise sub-status | One phase/status badge plus vertical remaining-work roadmap | Coarse position and exact machine state are both needed |
| Attention | Labelled kind badges; failure/escalation are visually louder | One “Next action” panel with owner, action, and evidence | Avoids color-only status and diffuse action lists |
| Progress | Running-stage label only | Runs tab and links to live monitor | Live token/cost telemetry would overload cards |
| Evidence | Deliberately omitted | Versioned docs, ledger events, runs, review/failure spotlight | Evidence belongs where it can be inspected, not skimmed |
| Ownership | Claim initials on relevant attention badge | Actor/claim context in gate and ledger | Supports shared queues without inventing assignments |
| Autonomous state | Explain no results; clear filters and create/import actions | “Veto is working” with current stage, progress, and last activity | The page should clarify who owns the next move |
| Responsive | Horizontally scrollable fixed-width columns below 1400 px | Main content and context rail stack at narrow widths | Preserves density without compressing cards into illegibility |
| Live behavior | SSE moves cards and refreshes attention badges | SSE updates gate, status, run, and artifact state | The UI remains a projection of the running conductor |

## Core journey

1. The operator opens Home and scopes the board to all projects or one
   project.
2. They scan failure/escalation badges first, then routine questions and
   approvals. Cards without a human move still show pipeline position.
3. Selecting a card navigates to `/tickets/:workspace/:id` and preserves the
   global shell.
4. Ticket Focus identifies the object, shows one current status, and places the
   immediate move in “Next action.”
5. The operator answers, approves, retries, or requests changes, then inspects
   documents, activity, runs, or the status-specific spotlight as needed.
6. Returning to Board restores the same workspace/filter context when the live
   API implementation lands.

## Information hierarchy

### Visible at a glance

- Phase column and column count/WIP state
- Ticket ID, title, priority, exact sub-status, workspace, and age
- Human-attention kind, claim initials, and running-stage label
- Failure or escalation label in addition to its semantic color

### Secondary disclosure

- Card action menu: claim, snooze, retry, or won't-do when allowed
- Full badge explanation and last meaningful activity
- Server-provided valid drag targets; invalid columns never appear actionable

### Detail page only

- Full problem statement and metadata
- Current question/approval/failure evidence and response controls
- Spec score, repositories, branch/worktree, family/dependencies
- Versioned PRD/TDD/test documents and before/after diffs
- Complete ledger, run usage, transcripts, findings, and test reports
- Contextual AI edit proposal and approve-to-commit flow on the selected object

## Card-to-detail information mapping

| Information | Dashboard card | Detail page | Reason |
| --- | --- | --- | --- |
| Ticket ID | Always | Always in title | Stable recognition across navigation |
| Title | One- or two-line concise title | Full title and summary | Cards must stay scannable |
| Workspace | Compact meta line | Header and Key facts | Needed for unified-board disambiguation |
| Priority | Compact `P0`–`P3` label | Header and Key facts | Supports board sorting and focused judgment |
| Phase | Column position | Status badge + vertical roadmap | Position is spatial on the board and explicit in focus |
| Raw status | Compact text/chip | Header, gate, and spotlight | Precise conductor state still matters |
| Attention kind | Labelled badge | Full “Next action” panel | The card signals; the focus page resolves |
| Claim | Initials on attention signal | Actor and claim controls | Enough ownership context without card clutter |
| Age | Compact relative time | Activity/ledger timestamps | Relative recency helps scan; audit needs exact records |
| Active run | Stage and progress hint | Runs tab plus monitor link | Avoids live counters on every card |
| Spec score | Omitted | Key facts and document review | It is diagnostic, not a primary board-routing signal |
| Token/cost usage | Omitted | Runs and ledger | Prevents the board becoming a metrics report |
| Documents and versions | Omitted | Documentation tab with diffs | Requires focused space and evidence context |
| Findings/tests | Attention count at most | Review spotlight/full review | Counts can route attention; details need a review surface |
| Full history | Omitted | Activity ledger | Keeps the card present-focused and the audit complete |

## Card anatomy and states

Cards are compact interactive records, not decorative dashboard tiles. The
whole card is a link; secondary controls remain real labelled buttons.

- **Default:** ID, priority, title, sub-status, workspace, and age.
- **Needs attention:** one or more labelled gate badges; claim initials when
  applicable.
- **Failure:** remains in its last meaningful phase with a red leading edge and
  solid `FAILED` label.
- **Escalated:** remains in Backlog with a solid orange `ESCALATED` label.
- **Running:** adds a mint activity dot and stage/progress text.
- **Completed:** quiet treatment in Done; only the most recent items remain
  expanded.
- **Selected/focus:** navigation, not a persistent selected-card split view.
- **Empty:** no fake cards; each column says “No tickets,” with a board-level
  explanation and create/import action.

## Ticket-focus information architecture

1. Back link, ticket identity, one phase/status badge, and global surface links.
2. Pinned “Next action”: question, approval, failure recovery, or an active
   “Veto is working” state. The action is completed inline.
3. Tabs: Overview, Documentation, Activity, Runs, plus one status-conditional
   spotlight (`Code review`, `Failure`, or `Split plan`).
4. Narrow context rail: current Status, vertical What's-left roadmap, and Key
   facts. AI is contextual inside ticket/document/code-review editing.

## Visual system

- **Personality:** precise, calm, technical, and evidence-led. Dense like an
  operations console, but with deliberate hierarchy and readable language.
- **Canvas/surfaces:** `#0B0D10` canvas, `#0E1115` sidebar,
  `#13171C` surface, `#191F26` elevated, `#202730` hover.
- **Borders:** `#303944` strong and `#242B33` subtle; no glass, glow, or
  gradients.
- **Text:** `#F3F5F7` primary, `#A7B0BA` secondary, `#727D89` muted.
- **Semantic colors:** mint `#63DFC0`, focus blue `#78A9FF`, success
  `#55CF86`, warning `#F2B84B`, danger `#F06D6D`, escalation
  `#E99462`, question/spec `#B59AF4`. Every color signal has text or an icon.
- **Typography:** Inter for UI; JetBrains Mono for identifiers, statuses,
  timestamps, hashes, paths, counts, and code.
- **Geometry:** 4–8 px radii, 1 px borders, compact 28–36 px controls, 8/12/16
  px spacing rhythm. Pills are reserved for status chips and filters.
- **Icons:** Lucide, generally 13–16 px at 1.8 stroke weight; icon-only buttons
  require accessible names and tooltips.
- **Focus/interaction:** 2 px blue visible focus ring; selected tabs use a mint
  underline; hover changes both surface and border; disabled actions remain
  legible and non-interactive.

## Filters, sorting, and grouping

- Global workspace scope in the context bar.
- Board/Inbox tabs, with the last choice persisted by the production client.
- “Only my moves” filter for unclaimed plus current-actor claims.
- Board grouping is fixed by phase; manual card ordering is intentionally absent.
- Within a phase: failure/escalation attention, other attention, priority, then
  surfaced/updated age.
- Done shows recent terminal tickets and an “and N more” expander.
- Non-ticket survey/import gates live in the Ops strip, never fake board columns.

## Non-happy states

- **Loading:** preserve column geometry with short neutral skeleton rows; keep
  scope controls disabled until the projection arrives.
- **No tickets/no results:** use the implemented board-level explanation, empty
  columns, Clear filters, and Create/import actions.
- **API error:** retain the last projection, show a labelled stale/error banner,
  and offer retry. Do not clear the board on a transient SSE failure.
- **Stale state:** show “Updated … ago”; reconnect re-reads the durable REST
  projection before resuming SSE.
- **Permission/conflict:** disable disallowed actions; server `409` on stale drag
  returns the card and explains that another operator changed the gate.
- **Focus-page failure:** the ticket identity and cached facts remain visible;
  only the failed panel shows retry/error treatment.

## Accessibility and responsive behavior

- Cards are links with visible focus; secondary actions are buttons, not nested
  click targets.
- Board columns are labelled regions, statuses have text labels, and live counts
  should be announced without moving keyboard focus.
- At 1024×768 the persistent sidebar compresses, board columns scroll
  horizontally, and Ticket Focus keeps the decision panel before the context
  rail. At narrower widths the rail stacks after the primary content.
- Reduced-motion mode removes run-dot pulses and card-return animation.
- Minimum contrast is maintained for normal text, focus, and semantic borders;
  muted metadata is never the sole carrier of required information.

## Assumptions and unresolved implementation gaps

- The prototype uses deterministic fixtures and is visibly labelled `Demo data`.
  Production REST/SSE behavior is untouched.
- `GET /board` does not yet exist. It must return server-derived phase,
  attention, claim/snooze state, and `drop_targets`; the UI must not duplicate
  transition authority.
- `gate_items.snoozed_until` is still required for board/inbox snoozing.
- Ticket-scoped chat-to-edit is specified but still needs the `/interview`
  `ticket_ref`/`target` behavior and guarded apply/discard endpoints.
- Review spotlight fidelity still depends on the missing review-read API for
  review.json, diff, and test-report data.
- Restoring exact board filter/sort state after returning from focus needs URL or
  session-state persistence in the production Home implementation.

## Prototype and captures

Run the UI and capture the scenarios:

```bash
pnpm --filter @veto/ui dev --host 127.0.0.1 --port 4173
pnpm --filter @veto/ui capture:dashboard
```

Demo routes:

- Populated Board: `/?demo=1`
- Empty/no-results Board: `/?demo=1&scenario=empty`
- Normal Ticket Focus: `/tickets/team-a/SR-0133?demo=1`
- Attention-required Ticket Focus: `/tickets/team-a/SR-0142?demo=1`
- Documentation-edit Ticket Focus: open the `Documentation` tab on
  `/tickets/team-a/SR-0142?demo=1`

The capture script writes desktop 1440×1024 and compact 1024×768 PNGs under
`docs/design/mockups/dashboard-focus/` and fails when the browser reports a
console or page error.
