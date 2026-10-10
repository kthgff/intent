# PRD — Board Assistant: conversational copilot on the idea canvas

Status: implemented 2026-10-09 (wave W24, wp-161…wp-167). Companion to `s-16-board-canvas.md`,
`BOARD-CANVAS-TDD.md`, and the §15.9 Interview Orchestrator (wp-145/146/147).
`PRD.md` §15.3 remains authoritative for board semantics and §15.9 for
interview internals; this document specifies a **new surface** that joins
them — plus one new durable entity (`board_proposals`) and the LLM seam
the orchestrator already defines but nothing yet wires. Technical design:
`BOARD-CHAT-TDD.md`.

## Problem

The idea board is the funnel's front end — capture, arrange, discover,
synthesize. Two gaps make it hard to get a board to synthesis-ready:

1. **Building a dense board is manual.** Every sticky, goal, zone, and
   `serves` edge is a direct-manipulation gesture. Turning a vague idea
   into a board with goals, problems, constraints, wants, avoids, and
   open questions takes dozens of individual edits — exactly the
   coverage synthesis needs and exactly what humans under-produce.
2. **Discovery lives off-canvas.** The Interview Orchestrator
   interrogates into knowledge slots and documents, but its surface is a
   separate screen whose output is statements, not board content. The
   interview can't see the canvas, and the canvas can't see the
   interview. The only board→discovery affordance today is a disabled
   "Synthesize" button.

## Goal

A persistent **Board Assistant** on every idea board: a floating chat
panel with a shared, durable thread where the user (and any teammate)
commands the canvas and is interviewed by it — and where **everything
the assistant does to the board arrives as an explicit proposal the
human accepts or rejects**.

The assistant's north star is moving the board toward synthesis: build
a board from scratch, deepen an existing one, or execute commands —
always leaving the board denser, better connected, and closer to the
≥1-goal / coverage bar that scoped synthesis requires.

Two architectural anchors make this a feature, not a toy:

- **Proposals-only writes.** "Agents propose. Humans veto." The
  assistant never mutates `board_items` directly; each change is a
  durable, attributable, reversible `board_proposals` row rendered as a
  ghost on the canvas until decided.
- **The interview is the §15.9 engine.** Answers extract to
  `semantic_statements` with the original text preserved; proposals link
  item → statement → transcript turn. Meaning stays in the ledger; the
  board stays presentation.

## Non-goals (v1)

- No auto-committed writes — nothing lands without an accept.
- No `/organize` or `/import` skills (clustering, bulk-paste intake are
  follow-ups; `/critique` covers the gap-hunting case).
- No private/forked threads (`interview_branches` stays ready for it;
  the thread is shared).
- No assistant-initiated messages — proactivity is limited to
  deterministic suggestion chips computed from board state.
- No token streaming — assistant turns post whole, after the durable
  write (the SSE event is a hint, the row is the truth).
- No statement editing in chat (the inspector/ledger own
  confirm/dispute/correct).
- No entity-card content edits — initiative/feature/ticket ref cards may
  be repositioned by proposal, never rewritten (they're projections of
  real entities edited at source).
- No new kind taxonomy — proposals emit existing `kind`/`note_kind`
  values only.
- No voice, attachments, or multi-board commands.

## Placement

A floating, draggable, collapsible panel over the canvas —
copilot-style, closable to a corner button. It does not dock; the
Inspector and tool rails keep their edges.

```text
┌─ board canvas ──────────────────────────────┐
│                       ┌─ Assistant ───────┐ │
│                       │ Thread | Underst. │ │
│                       │ ────────────────  │ │
│      canvas           │ messages          │ │
│    (ghost cards)      │ proposal batches  │ │
│                       │ ────────────────  │ │
│                       │ [skill pills]     │ │
│                       │ / input           │ │
│                       └───────────────────┘ │
└─────────────────────────────────────────────┘
```

- Gated by `ui.idea_canvas_v2` (the chat is a canvas-era surface) AND a
  new flag `ui.board_chat`; flag-off boards get neither.
- Two tabs in one panel: **Thread** (default) and **Understanding**
  (the wp-146 understanding payload embedded, not duplicated).
- Below 900 px the canvas is read-only but the panel stays fully
  functional — proposals render as an in-thread list instead of canvas
  ghosts, and accepting works without spatial chrome.

## Functional requirements

### R1 — Thread

- One durable, **shared** conversation per board. Every user with board
  access sees the same thread; user turns carry actor attribution.
- The thread is an `interview_sessions` row scoped `subject: board:<slug>`
  — pause/resume, snapshots, and the append-only `interview_messages`
  transcript are inherited, never reimplemented.
- Message kinds: user text, assistant text, system run markers
  (`interview started`, `run ended — summary`), and **proposal batches**
  (see R3).
- Assistant messages deep-link to the canvas: clicking a proposal
  reference pans/zooms to the proposed location.

### R2 — Skills and command mode

- The input accepts free text plus `/`-prefixed skills. A **skill pill
  row** above the input lists available skills; clicking a pill
  populates `/skill ` (or a completed form) into the input.
- v1 skills:

| Skill | Behavior |
| --- | --- |
| `/interview` | Starts an interview run (R4). Optional subject: `/interview auth` or with items selected scopes it. |
| `/expand` | Selection-scoped mini-interview — subject = selected item(s) or the zone under focus; proposals cluster near the selection. Requires a selection; otherwise the pill is inert with an explanation. |
| `/critique` | One-shot board analysis (R6). Posts findings to the thread; each finding may carry proposals. Never writes. |
| `/<synthesis>` | Not a skill — the run-end readiness summary carries a one-click **Run synthesis?** action (R7). |

- **Free text = command mode.** The assistant classifies the turn:
  answers questions from board + project context, or translates action
  requests into proposals ("add a constraint about auth"). Ambiguous
  requests get **one** clarifying question — never a guess (fail-closed).
- Skill discovery aid: deterministic **suggestion chips** surface in the
  panel when the board state warrants (no goals → `Run /interview`;
  open decisions → `Resolve N decisions`; draft-ready → `Looks ready —
  synthesize?`). Chips are computed from board state, never LLM
  messages; the assistant never speaks first.

### R3 — Proposals

- **Every board mutation is a durable proposal.** Ops vocabulary
  (per proposal, one logical change — batched ops share a `batch_id`):
  `create-item` · `patch-item` (title/body/note_kind/importance/
  note_status/topic/applies_to/rationale/color) · `move-item` (x/y/zone)
  · `connect` (drawn connector) · `serve` (`serves` edge — the canonical
  goal edge; connectors stay hints) · `delete-item` (status `discarded`
  — soft-delete only).
- Proposal states: `pending → accepted | rejected | stale | superseded`.
- **Rendering**: pending proposals render as ghost cards on the canvas —
  dashed border, `proposed` chip, assistant attribution. Ghosts are not
  selectable/draggable, never enter history, and disappear on
  reject/accept.
- **Timing is hybrid**: item proposals (new stickies from an answer)
  stream per-turn so the board visibly fills; structural ops (zones,
  connectors, rewrites, moves, deletes) batch at assistant checkpoints —
  "from the last few answers, here's the structure I'd propose" — one
  accept-all per batch plus per-item controls.
- **Placement is contextual**: creates carry coordinates resolved
  deterministically — inside the referenced zone when `zone` is set,
  adjacent to related items (serves target / connector target /
  applies_to anchor), else at the content bounding-box edge nearest the
  interview's subject. Placement is a pure function; it never overlaps
  existing cards.
- **Accept semantics**: accept executes each op through the *same*
  legality as manual writes (kind/ref guards, status enum, OCC fencing
  on the `base_updated_at` captured at proposal time). A stale base →
  the whole proposal 409s, marks `stale`, and the assistant may
  re-derive. Accepted creates stamp `provenance: 'inferred'` and link
  item → source statement(s) → transcript turn.
- **Undo**: accepted writes are ordinary board writes — they enter the
  existing session `CommandHistory`, so undo works like any edit
  ("undo" is a new fenced write, never a rewind).
- **Concurrency**: proposals from different users' turns coexist;
  identical pending proposals supersede their predecessors.

### R4 — `/interview`

- **Agenda: goals, then gaps.** The run opens by confirming or
  establishing goal stickies (synthesis requires ≥1 in scope and serves
  edges anchor to them — existing goals are confirmed, never re-asked),
  then pursues the weakest coverage in the wizard's slot list.
- **One wizard per `board_type`**: `board-<type>` registered per
  `BOARD_TYPES` (`board-new-project`, `board-feedback`, …) plus
  `board-generic` for untyped boards. Each declares its knowledge slots;
  a feedback board hunts themes/severity, a new-project board hunts
  goals/scope. Slots version with `wizard_versions`; in-flight runs keep
  their version.
- **Pure conversation.** The assistant asks one question at a time in
  prose — no question cards, no option chips. Knowledge slots,
  question candidates, and readiness stay underneath as bookkeeping;
  the Understanding tab shows them live.
- **Context-first**: the run reads the board surface + project context
  (dossier, initiatives, features, tickets) before planning. It never
  re-asks what the project already knows — the planner's eligibility
  rules do the skipping; the prompt gets the assembled context.
- **Per answer**: persist the turn → extract statements (original text
  preserved, `source_ref` = the transcript turn) → stream item
  proposals → next question, only after the answer is durable (the
  existing ordering rule).
- **Contradictions interrupt.** A material conflict surfaces
  immediately in-thread — "this conflicts with *must work offline* —
  which stands?" — and records a `statement_decisions` row. Resolution
  produces a supersede proposal; conflicts are never silently merged.
- **Ending is user-driven.** `/interview end`, a natural-language
  equivalent, or closing the run ends it — the engine never declares
  itself done. On end, the assistant posts the **readiness summary**
  (R7).
- Pause/resume is inherited from the session machinery: closing the
  panel or the board pauses nothing (the session persists); resuming a
  paused run offers the knowledge-diff briefing.

### R5 — `/expand`

- Requires a selection (items or one zone). Runs the same interview
  engine with the subject narrowed to the selection — the planner's
  context is the selected items + their statements + neighbors.
- Proposals anchor to the selection: new items place adjacent to the
  anchor cluster; a refinement of a sticky proposes a `patch-item`
  (not a duplicate).

### R6 — `/critique`

- Read-only pass over board + bound statements posting a findings
  message: vague/empty stickies, contradictions (each linked to its
  decision item), coverage gaps by note_kind, orphans (no zone, no
  serves, no connectors), stale or unresolved `question` notes.
- Deterministic checks always run; LLM findings ride only when a
  completion provider is configured.
- Findings carry optional proposals (`patch-item` to sharpen,
  `question` stickies for gaps); accepting is the user's call.

### R7 — Readiness summary and synthesis hand-off

- On run end (and on demand — "are we ready?"), the assistant posts a
  structured summary: goal coverage (count + serves wiring), note-kind
  coverage, open decisions, deferred items, and the session's
  `evaluateReadiness` flags.
- When `draft_ready`, the summary carries a one-click **Run
  synthesis?** action chip that invokes the scoped-synthesis entry
  point — the same call the canvas's (future) Synthesize button issues.
  The chat proposes; it never owns the pipeline. Synthesis still
  requires ≥1 goal, enforced downstream.
- The assistant may *answer* a readiness question any time ("what's
  missing?") — readiness is available on request, never pushed.

### R8 — Context scope

- The assistant reads: this board's surface (items + statements +
  connectors + zones + votes), the tray, and **project context** —
  dossier, initiatives, features, tickets (summarized, citation-linked).
- It writes: proposals on this board only. Project-level entities are
  context, never targets — the assistant cannot create tickets or
  initiatives from chat (synthesis owns that).

### R9 — Multiplayer

- The thread is shared: all turns are attributable (`created_by` on the
  transcript row), all proposals visible to every viewer.
- A teammate's pending proposals are decisionable by any board member —
  the deciding actor is recorded.
- SSE fan-out: `interview_updated` (existing) refreshes the thread;
  a new `board_proposal` event refreshes ghosts.

### R10 — Degradation

- With no completion provider configured, the assistant degrades loudly
  and keeps working: the deterministic planner still interviews
  (slot-driven questions), extraction falls back to verbatim statements,
  `/critique` runs its deterministic checks only, and command mode
  replies that it needs `assistant.model` configured. Nothing silently
  no-ops — the degraded state is a banner, not a mystery.

## Acceptance criteria

| Case | Criteria |
| --- | --- |
| `case:board-chat-01` | `ui.board_chat` + canvas v2 on: assistant button opens the floating panel; flags off → no affordance; panel drags, collapses, reopens with thread intact |
| `case:board-chat-02` | Skill pills list `/interview`, `/critique`, `/expand`; clicking populates the input; free text routes to command mode |
| `case:board-chat-03` | `/interview` on an empty board opens a run; first question targets goals; answering produces ghost stickies on-canvas, linked item→statement→turn |
| `case:board-chat-04` | Accept writes the item through normal legality (OCC + guards) with `provenance: 'inferred'`; reject discards the ghost; accept-all applies a batch atomically |
| `case:board-chat-05` | Existing goals are confirmed, never re-asked; after goals the run pursues the weakest coverage slot |
| `case:board-chat-06` | A contradicting answer surfaces a decision in-thread and a `statement_decisions` row; ruling produces a supersede proposal |
| `case:board-chat-07` | `/expand` with a selection scopes questions to it and anchors proposals adjacent; without a selection the skill explains instead of running |
| `case:board-chat-08` | `/critique` posts findings with per-finding proposals; no writes occur without accepts |
| `case:board-chat-09` | `delete`/`patch`/`connect`/`serve`/`move` ops each land as proposals and commit through their fenced paths; entity-ref cards can move but never content-edit |
| `case:board-chat-10` | Ending a run posts the readiness summary; when `draft_ready` the summary carries the one-click synthesis action |
| `case:board-chat-11` | A second client sees the same thread and ghosts via `interview_updated` + `board_proposal` events; a teammate can decide another's proposal |
| `case:board-chat-12` | Below 900 px: full chat function with in-thread proposal lists; a stale-base accept returns 409 and the proposal marks `stale` |
| `case:board-chat-13` | No completion provider: planner + verbatim extraction still run; command mode and LLM critique degrade with the banner visible |

## Rollout

Ships under a new flag `ui.board_chat` (default off), additionally
requiring `ui.idea_canvas_v2`. Rollback = flag off — no canvas or data
changes are gated on it. One new table (`board_proposals`), one widened
transcript column (`interview_messages.created_by`), new API routes
under `/boards/:board/assistant`, and the completion-provider seam —
all additive, none touching existing write paths until a human accepts.
