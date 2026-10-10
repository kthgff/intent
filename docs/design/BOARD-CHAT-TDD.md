# TDD — BOARD-CHAT: conversational copilot + proposal pipeline on the idea canvas

Status: implemented 2026-10-09 (wave W24, wp-161…wp-167). Requirements are enumerated in
`BOARD-CHAT-PRD.md`. `PRD.md` §15.3/§15.9, `ARCHITECTURE.md`, `API.md`,
`SCHEMAS.md`, and `DB-SCHEMA.md` remain authoritative; the contract
amendments named here must land with the implementation.

## Architecture

### Outcome

Every idea board gains a persistent **assistant thread**: one durable
`interview_sessions` row scoped to the board, presented as a floating
chat panel on the canvas. Through it the user runs three skills —
`/interview` (goals-then-gaps questioning), `/expand` (selection-scoped
interview), `/critique` (read-only gap analysis) — and issues freeform
commands. **Every assistant mutation is a durable `board_proposals`
row**: ghost-rendered on the canvas, committed through the existing
OCC-fenced legality only when a human accepts.

Nothing here re-implements machinery: the thread *is* an interview
session (transcript, branches, snapshots, slots inherited); interview
runs are `interview_branches` inside it; extraction reuses
`runExtraction`/`ingestExtraction`; readiness reuses
`evaluateReadiness`. The new machinery is exactly three pieces:
`board_proposals`, the placement/projection of pending proposals, and
the **completion-provider seam** — the `extract`/`propose` injection
points exist in the engine but no production wiring exists today.

### Component topology

```text
IdeaBoard (route coordinator — extended)
├── BoardCanvas (+ Inspector)                      [existing]
│   └── ghost nodes/edges  ← projectProposals()    [new projection]
├── AssistantPanel                                 [new — floating]
│   ├── ThreadView       (messages + proposal batches)
│   ├── UnderstandingTab (existing UnderstandingPanel payload)
│   ├── SkillPills       (registry + suggestion chips)
│   └── ChatInput        (/ commands + freeform)
└── DeliveryView                                   [existing]

api/src/board-assistant.ts                         [new route file]
└── conductor/assistant/                           [new engine module]
    ├── thread.ts      board session get-or-create, message routing
    ├── runs.ts        /interview + /expand run lifecycle (branches)
    ├── skills.ts      skill registry + deterministic suggestion chips
    ├── proposals.ts   draft/accept/reject/supersede/stale
    ├── placement.ts   pure contextual-placement function
    ├── coverage.ts    board coverage + critique checks (pure)
    └── converse.ts    command-mode turn → {reply, ops} (LLM seam)
```

### Durable and transient state

**Durable:**

- The thread = `interview_sessions` row,
  `session_id = sessionIdFor('board-<type>', 'board:<slug>')`,
  `subject = 'board:<slug>'` (matches `extractBoard`'s subject
  convention), `wizard_id = board-<board_type>` (or `board-generic`
  when `board_type` is NULL), `mode = 'conversation'`.
- Transcript = `interview_messages` (+ one amendment: `created_by`
  column for shared-thread attribution — additive, nullable).
- Runs = `interview_branches` rows (`branch = 'run-N'`,
  `role = 'interview' | 'expand'`, `active → merged|abandoned`).
  Run-scoped messages carry the branch; the UI renders one merged
  chronological thread with system markers at run boundaries.
- Bookkeeping = `knowledge_slots`, `question_candidates`,
  `session_snapshots` — all session-scoped, all reused.
- **`board_proposals`** — the one new table (below).
- `statement_artifact_links` rows bind accepted items to their source
  statements: `artifact = 'board-item:<item_id>'` — reuses the existing
  link table; the provenance chain is item → artifact link → statement
  → `source_ref {kind:'interview-message', id:'<session>#<seq>'}`.

**Transient (view state, session-local):** panel open/position, active
tab, input draft, pending-selection for `/expand`. Ghost nodes derive
from `board_proposals WHERE status='pending'` — re-projected on every
load, never a second truth.

### Data model

```sql
-- 0015_board_chat.sql
ALTER TABLE interview_messages ADD COLUMN created_by TEXT;  -- attribution

CREATE TABLE board_proposals (
  workspace TEXT NOT NULL,
  org TEXT,
  proposal_id TEXT NOT NULL,
  board TEXT NOT NULL,
  session_id TEXT NOT NULL,            -- the board's thread session
  batch_id TEXT,                       -- checkpoint grouping; accept-all scope
  seq INTEGER,                         -- transcript seq that produced it
  op TEXT NOT NULL,                    -- BOARD_PROPOSAL_OPS
  payload TEXT NOT NULL,               -- json — op body (below)
  base_updated_at TEXT,                -- OCC fence for item-targeting ops
  anchor TEXT,                         -- json related item ids (explainability)
  provenance TEXT,                     -- json {statement_ids, branch}
  status TEXT NOT NULL,                -- pending|accepted|rejected|stale|superseded
  created_by TEXT NOT NULL,            -- actor whose turn produced it
  decided_by TEXT, decided_at TEXT,
  created_at TEXT, updated_at TEXT,
  PRIMARY KEY (workspace, proposal_id)
);
CREATE INDEX idx_board_proposals_board
  ON board_proposals (workspace, board, status);
```

Op payloads (zod `ProposalOpSchema`, discriminated on `op` — fail-closed
at draft AND at accept):

| op | payload |
| --- | --- |
| `create-item` | `{kind?, note_kind?, title?, body?, ref?, topic?, importance?, applies_to?, rationale?, color?, x, y, w?, h?, zone?, temp_id?}` — same legality as `POST /boards/:board/items`; `temp_id` declares a same-batch alias other ops in the draft may use wherever an item id is expected (`zone`, `id`, `goal_item_id`, connector endpoints) — see "Same-batch references" below |
| `patch-item` | `{id, patch}` — `patch` = the single-item PATCH field set (incl. `note_*`, `serves` is NOT here) |
| `move-item` | `{id, x?, y?, zone?}` — geometry only |
| `serve` | `{id, goal_item_id}` — appends to `board_items.serves` (the canonical edge) |
| `connect` | `{source_item_id, target_item_id, label?}` — drawn connector (hint, never writes `serves`) |
| `connector-remove` | `{id}` — supersede, never hard delete |
| `delete-item` | `{id}` — `status: 'discarded'` only; `consumed`/`frozen`/`shipped` refuse |

Enums added to core: `BOARD_PROPOSAL_OPS`, `BOARD_PROPOSAL_STATUSES`
(`pending|accepted|rejected|stale|superseded`). Store interface:
`upsertBoardProposal`, `getBoardProposal`,
`listBoardProposals({workspace, board, status?})`,
`supersedePendingProposals({board, op, itemId})`. Event names:
`assistant_message`, `proposal_created`, `proposal_resolved` (union
amendment + `EVENT_NAMES`).

### Contract amendments

1. **`interview_messages.created_by`** — nullable attribution column;
   the shared thread needs per-turn actor for a team surface. Existing
   rows stay NULL (session `created_by` is the fallback display).
2. **`StreamEvent.type += 'board_proposal'`** — payload
   `{workspace, board, proposal_id, status}`; emitted after the durable
   proposal write, never before.
3. **`serves` writes via proposal only** — a `serve` op patches
   `board_items.serves` through the single-item legality (which already
   accepts `serves` in `PatchItemBody` — discovery.ts). The batch
   `ItemPatch` on `PATCH /boards/:board/items` stays unchanged; proposal
   commits always route through the single-item path so legality lives
   in exactly one place.
4. **Completion provider** — `CompletionProvider = { converse(messages,
   opts): Promise<string> }`, resolved at server start through the
   wp-155 routing registry (no call site hardcodes a model):
   `resolveModelRoute(config, 'assistant')` — kind `assistant`, latency
   class `interactive`, `schema_required` honored. The concrete client
   is a thin OpenAI-compatible chat-completions POST
   (`packages/api/src/openrouter.ts`) against OpenRouter, keyed by
   `deps.config.secrets.OPENROUTER_API_KEY` (.env already carries it for
   aider). Base URL is a constant — self-hosted endpoints (Vast/vLLM)
   are a follow-up. Documented default (SETTINGS.md, never hardcoded):
   `models.assistant.primary: qwen/qwen3-30b-a3b-instruct-2507`,
   `providers: [openrouter]`, `max_output_tokens: 2048`. Unresolved
   route or missing key → `undefined`; every consumer has a
   deterministic fallback (planner, verbatim extraction, deterministic
   critique). **Fail-loud**: the GET payload reports
   `model: configured|absent` so the UI can show the degradation banner.
   Structured turns send `response_format` json_schema when the route
   allows; output is re-validated against `ConverseOutputSchema`
   fail-closed either way — malformed → zero ops, the reply says so.
   No token streaming v1 (PRD non-goal).
5. **Wizard catalog** — `board-generic` + `board-<type>` for every
   `BOARD_TYPES` value, registered lazily via the existing
   `seedMvpWizards`-style path at session start (GETs stay read-only).

### Board wizard configs

`board-<type>` wizards declare coverage slots. Base list (shared shape,
per-type labels/questions/extras):

| slot | required | accepts | note |
| --- | --- | --- | --- |
| `goals` | ✓ | `want`, `requires` | asked first (impact 1.0) — the synthesis edge target |
| `problems` | ✓ | `problem`, `observation` | |
| `wants` | ✓ | `want`, `requires` | |
| `constraints` | ✓ | `constraint`, `prohibits` | |
| `avoids` | — | `avoid`, `prohibits` | optional |
| `open-questions` | — | `question` | optional |
| `decisions` | — | `decision` | optional |
| per-type extras | varies | — | `board-feedback`: `themes`, `severity`; `board-import`: `source-fidelity`; `board-release-planning`: `targets`, `cut-criteria` |

**Goals-first is a seeding rule, not a prompt hack**: at session start
(and refreshed at each run start) `seedBoardSlots` upgrades slots from
`missing` → `inferred` where the board already covers them. Coverage is
deterministic: `goals` covered when ≥1 item is a `serves` target;
`problems` covered when ≥1 `problem` note exists; etc. `inferred` slots
are confirmable in the Understanding tab; `missing` required slots are
what the planner asks — goals land first because `impact` is highest.

> Spec gap resolved here (backport on implementation): the item taxonomy
> has no explicit `goal` marker — goal-ness is conferred by *being a
> serves target* (D33). The goal phase therefore ends by proposing serve
> ops wiring existing items to the goal sticky, so "≥1 goal in scope" is
> measurable as "≥1 serves-target item". Goal display derives
> (`isGoalItem` = id ∈ ⋃ serves), no taxonomy change.

### The turn pipeline

`POST .../assistant/messages {text}` routes by state:

1. **Pending asked question on an active run branch** →
   `interview.submitAnswer({questionId, branch})` — answer persists
   first (the existing ordering rule), extracts statements via
   `runExtraction` (or verbatim fallback), binds slots, plans + asks the
   next question.
2. **`/` skill** → `runs.startRun` / `runs.endRun` / `skills.critique`.
3. **Freeform command** → `converse()`: prompt = board context digest +
   recent turns → `ConverseOutputSchema {reply, ops[]}` — ops validate
   fail-closed (malformed → zero ops, the reply says so). Ops become a
   proposal batch.
4. After **any** turn: `draftProposals` for extracted statements —
   statement-intent → note_kind map:

   `want→want · requires→constraint · constraint→constraint ·
   prohibits→avoid · avoid→avoid · problem→problem · question→question ·
   decision→decision · observation→idea · assumption→idea (rationale:
   "assumption")`. Statements bound to the `goals` slot additionally
   produce `serve` ops wiring the goal to relevant anchors.

5. **Contradictions**: extraction-reported `contradicts` relations +
   `openDecisionsForSlots` surface a decision message in-thread —
   "this conflicts with X — which stands?" Resolution rides the existing
   `statement_decisions` decide actions; the outcome produces a
   supersede proposal.

### Proposals lifecycle

```text
draft (per-turn | checkpoint batch) → pending ──accept──→ committed via
single-item legality (OCC on base_updated_at)      │
   │                          ┌──reject──→ rejected│
   ├──supersede (newer dup)──→ superseded          └──409──→ stale
```

- `acceptProposal`: load (must be `pending`) → validate op schema →
  per-op legality (`assertCanvasItemKind`, `assertCanvasItemRef`, status
  enum, `consumed|frozen` refuse, `item.updated_at === base_updated_at`)
  → write via the SAME conductor functions manual writes use → stamp
  `provenance:'inferred'` on creates → `statement_artifact_links` rows
  → mark `accepted`. Batch accept = one `store.transaction` —
  all-or-nothing.
- `rejectProposal`: status + `decided_by` — the ghost vanishes, the
  record stays (audit).
- `supersedePendingProposals` on draft: an identical pending proposal
  (same item + overlapping op kind) is superseded, so the queue never
  grows stale duplicates.
- `stale`: accept-time fence mismatch marks it; the assistant may
  re-draft against the fresh row in a later turn.

**Same-batch references (`temp_id`, D69).** Proposals are decided
one row at a time, so an op that needs "the frame in this same batch"
cannot carry a durable item id. A `create-item` may declare
`temp_id`; refs to it are legal at draft (any dangling ref — neither
a board item nor a declared alias — drops fail-closed with a reason)
and resolve inside the accept transaction: batch accept applies rows
in dependency order (a referencing op pulls its create forward first;
cycles refuse), so a frame + contained notes + connectors commit
atomically. Individually accepting a row whose ref still names a
pending sibling's `temp_id` fails 400 in human language ("accept that
proposal first, or accept the whole batch together") and stays
`pending` — retryable, never `stale`. When a create with a `temp_id`
is accepted, its pending same-scope siblings' payloads are repointed
to the durable item id inside the same transaction, so the
frame-first-then-children order works row by row too. Alias scope =
same `batch_id`, else same `session_id`+`seq`; converse turns share a
generated `batch_id` so a multi-op reply is one accept-all checkpoint.
Ghost projection resolves `temp_id` refs to ghost ids (children render
inside the proposed frame, proposed edges draw between proposed
cards).

### Placement — `computePlacement` (pure, unit-tested)

Inputs: board items, pending proposal placements, the op's `zone` and
`anchor` ids. Order:

1. `zone` set → next free cell inside that zone's rect (32 px grid).
2. `anchors` non-empty → right of the anchor cluster's bounding box
   (+24 px gap), aligned to its top edge.
3. else → below the content bounding box (+24 px), column-flowed.

Collision-avoid: nudge along the grid until no overlap with items or
already-placed pending proposals. Deterministic — same inputs, same
coordinates; no LLM participation.

### Skills

- **`/interview [subject]`** → `runs.startRun`: ensures the thread
  session, re-seeds coverage, opens branch `run-N` (`role:'interview'`),
  optional subject scopes the prompt context (recorded as a system
  message — branches carry no metadata column, and none is added).
  First turn plans + asks the top slot question.
- **`/expand`** → same engine, `role:'expand'`, context = selected items
  + their statements + neighbors; proposals anchor to the selection.
- **`/critique`** → `coverage.critiqueChecks(surface)` (pure —
  vague/untyped/orphan/unanswered-question/missing-kind/no-goals/open-
  decisions findings) + optional LLM findings when the provider exists;
  posts one findings message with optional proposals.
- **Run end** → `runs.endRun`: branch → `merged`, posts readiness
  summary (`evaluateReadiness` + coverage); when `draft_ready`, the
  message carries `{action:'run_synthesis'}` — a one-click chip that
  calls the scoped-synthesis route (the same call the canvas Synthesize
  button will issue; hidden when the route isn't live).
- **Suggestion chips** — `suggestChips(board, session)` deterministic:
  no serves-target → `Run /interview`; open decisions → `Resolve N`;
  `draft_ready` → `Looks ready — synthesize?`. Never LLM, never a
  message — chips only.

### REST surface

| Verb | Route | Use |
| --- | --- | --- |
| GET | `/api/v1/boards/:board/assistant?workspace=` | `{session, messages, proposals, skills, chips, pending_question, model}` — one-load panel state |
| POST | `/api/v1/boards/:board/assistant/messages` | `{text}` → `{messages, proposals, pending}` — answers, commands, skill text |
| POST | `/api/v1/boards/:board/assistant/runs` | `{skill:'interview'\|'expand', scope?}` → `{branch, asked}` |
| POST | `/api/v1/boards/:board/assistant/runs/:branch/end` | `{summary}` — merge branch + readiness message |
| GET | `/api/v1/boards/:board/proposals` | `{proposals}` (filter `?status=`) |
| POST | `/api/v1/boards/:board/proposals/:id/accept` | one proposal → committed item(s) |
| POST | `/api/v1/boards/:board/proposals/:id/reject` | `{reason?}` |
| POST | `/api/v1/boards/:board/proposals/accept` | `{ids? \| batch_id?}` — atomic batch |

All bodies zod-strict (`WorkspaceName`/`BoardSlug` shared), errors map
through the existing `call()`/`ApiError` conventions, every mutation
emits SSE after the durable write.

### UI

- `AssistantPanel.tsx` — floating panel: drag by header (position →
  `localStorage veto.boardchat.pos.<ws>/<board>`), collapse to a corner
  button, Thread | Understanding tabs, message list (user/assistant/
  system markers), proposal-batch cards (per-item accept/reject +
  accept-all), skill pills + suggestion chips, `model:absent` banner.
- `projectProposals(proposals, items)` — projects pending proposals to
  ghost `CanvasNode`s/`CanvasEdge`s flagged `data.ghost`: dashed border,
  `proposed` chip, assistant attribution; not draggable, not
  selectable, excluded from history and marquee. Click → the thread
  scrolls to the source batch.
- `IdeaBoard.tsx` — panel mount + handlers; loads thread/proposals with
  board detail; `useStreamRefresh(load, ['interview_updated',
  'board_proposal', 'board_item_updated'])`.
- `api.ts` — `assistant()`, `assistantMessage()`, `assistantRun()`,
  `assistantEndRun()`, `boardProposals()`, `acceptProposal()`,
  `rejectProposal()`, `acceptProposals()`.
- Below 900 px: ghosts are skipped; proposals render as an in-thread
  list (the panel is the whole affordance — no canvas interaction
  required to decide).
- `styles.css` — `/* ---- BOARD-CHAT */` block on existing tokens;
  ghost = `outline: 2px dashed` + `proposed` chip reusing badge chrome.

### Accessibility and responsive behavior

- New assistant turns and proposal batches announce via an
  `aria-live="polite"` region; panel `Esc` collapses; `/` focuses input
  (inert while typing); skill pills are real buttons.
- Focus returns to the invoking control on collapse; proposal actions
  keyboard-reachable (`Enter`/`Space` on accept/reject buttons — no
  drag dependency below 900 px or anywhere).
- `prefers-reduced-motion`: panel appears/collapses instantly.

### Performance budget

- Panel GET is one request; thread paginates via the transcript's
  `after` seq (50-message pages) — never the whole log.
- Ghost projection is O(pending) and memoized on `(proposals, items)`;
  placement computed once at draft time, stored — never per render.
- `converse` calls are awaited server-side per turn (no streaming v1);
  a turn is one completion at most (interview turns add planner +
  extract = ≤3).
- Deterministic paths (no provider) never spend tokens — chip/coverage/
  placement are pure.

## Execution plan

| WP | Ticket | Scope | Key files |
| --- | --- | --- | --- |
| BA-A | wp-161 | Contracts: enums/schemas/`Store` iface, migration 0015, pg impl, event names, `api.ts` types, `ui.board_chat` flag | `packages/core/src/{enums,schemas,store,config}.ts`, `packages/store/migrations/pg/0015_board_chat.sql`, `packages/store/src/pg.ts`, `packages/ui/src/api.ts` |
| BA-B | wp-162 | Assistant engine: thread, runs/branches, coverage+placement (pure), proposals lifecycle, converse pipeline, critique checks, chip logic — deterministic paths first | `packages/conductor/src/assistant/*`, `conductor/test/assistant*.test.ts` |
| BA-C | wp-163 | Board wizard configs (`board-generic` + all `board-<type>`) | `conductor/src/interview/wizard.ts` (+ seed fn) |
| BA-D | wp-164 | OpenRouter `CompletionProvider` client, registry kind `assistant`, API routes + SSE | `packages/api/src/{board-assistant,openrouter}.ts`, `server.ts`, `packages/config`, `packages/prompts` |
| BA-E | wp-165 | Panel: ThreadView/UnderstandingTab/SkillPills/ChatInput + client wiring | `packages/ui/src/board-canvas/AssistantPanel.tsx`, `assistant.ts`, `IdeaBoard.tsx`, `styles.css` |
| BA-F | wp-166 | Ghost projection + canvas render path + narrow-screen proposal list | `board-canvas/{model,nodes}.tsx`, `BoardCanvas.tsx`, tests |
| BA-G | wp-167 | Skills polish (`/expand` scoping, critique findings), a11y, e2e, docs backport (`API.md`, `DB-SCHEMA.md`, `SCHEMAS.md`, `SETTINGS.md`, `TRACKER.md`) | as above + docs |

Sequenced A→G; A lands first (contracts before surfaces — the
parallel-agent rule). Lanes after wp-161: `{wp-162, wp-163, wp-166}`
run in parallel (disjoint file ownership; wp-166's ghost-prop is
dormant until wp-165 wires IdeaBoard). wp-164 waits on wp-162's engine
symbols; wp-165 on wp-164's routes; wp-167 closes the wave.

## File plan

| Path | Change |
| --- | --- |
| `packages/core/src/enums.ts` | `BOARD_PROPOSAL_OPS`, `BOARD_PROPOSAL_STATUSES`, event names |
| `packages/core/src/schemas.ts` | `BoardProposalRowSchema`, `ProposalOpSchema`, `ConverseOutputSchema` |
| `packages/core/src/store.ts` | proposal store methods |
| `packages/store/migrations/pg/0015_board_chat.sql` | **new** — `board_proposals`, `interview_messages.created_by` |
| `packages/store/src/pg.ts` | proposal CRUD + created_by passthrough |
| `packages/conductor/src/assistant/*.ts` | **new** — thread/runs/skills/proposals/placement/coverage/converse |
| `packages/conductor/src/interview/wizard.ts` | board wizard configs + `seedBoardWizards` |
| `packages/conductor/src/loop/deps.ts` | `'board_proposal'` StreamEvent |
| `packages/api/src/board-assistant.ts` | **new** — assistant + proposal routes |
| `packages/api/src/server.ts` | register routes; provider wiring |
| `packages/ui/src/board-canvas/AssistantPanel.tsx` | **new** — floating panel |
| `packages/ui/src/board-canvas/assistant.ts` | **new** — pure helpers (chips display, proposal projection, intent→kind meta) |
| `packages/ui/src/board-canvas/model.ts` | ghost projection types |
| `packages/ui/src/board-canvas/BoardCanvas.tsx` | ghost node/edge render path |
| `packages/ui/src/screens/IdeaBoard.tsx` | mount + handlers + stream refresh |
| `packages/ui/src/api.ts` | client methods |
| `packages/ui/src/styles.css` | BOARD-CHAT + ghost styles |
| `packages/ui/test/board-chat*.test.tsx` | panel + projection + interaction tests |
| `docs/{API,DB-SCHEMA,SCHEMAS,TRACKER}.md` | contract backports |

## Risks / open items

- **No production completion provider exists** — the `extract`/`propose`
  seams are injectable but the API wires none today. BA-D introduces
  the first (OpenRouter chat completions behind `assistant.model`);
  until then every path must honor the deterministic fallback — the
  feature is *designed* to run degraded, not to demand a key.
- **Command-mode intent classification** is an LLM judgment call —
  mitigated by fail-closed `ConverseOutputSchema` (bad ops parse to
  zero ops + an explanation, never a guess) and one-question clarify.
- **Run ↔ freeform ambiguity**: during an active run, plain text is
  treated as the answer; commands must `/`-prefix. The pending question
  is always visible to make the routing obvious.
- **Branch-as-run bookkeeping**: branches were built for stakeholder
  split/merge; using them for run lifecycle is a reuse, not a new
  concept — but `role` doubles as the run kind (`interview`/`expand`)
  since branches carry no metadata column. If run metadata grows, add
  a `meta` column rather than encoding in `branch`.
- **Goal marker absence** resolved above (serves-target derivation);
  if a dedicated `goal` marker lands later (wp roadmap), coverage +
  display migrate — the proposal/ops vocabulary doesn't change.
- **Synthesis route** doesn't exist yet (button disabled) — the
  readiness chip renders only when `draft_ready` AND the route is
  live; the chat owns no pipeline state.
- **Stale-under-churn**: boards edited by teammates mid-interview can
  invalidate placements (pure function → recompute on accept is cheap;
  proposals target durable rows, geometry collisions resolve
  client-side at render).

## Threat model

- Proposals never bypass legality — accept re-runs every guard
  (`assertCanvasItemKind/Ref`, status enums, `consumed|frozen` refusal,
  `ref` http/https pinning). A crafted proposal payload dies in zod.
- The assistant **writes nothing durable except proposals, messages,
  and statement/decision rows** — `board_items` changes require a human
  accept. There is no "auto-apply" code path to misconfigure.
- `created_by` on messages/proposals records the human whose turn
  produced them — assistant authorship is attribution, never identity;
  actor strings stay human.
- Board content is prompt input: untrusted text can ask the assistant
  for things, but the output ceiling is a *pending proposal* — the
  human gate caps prompt-injection blast radius at "a suggestion you
  can reject".
- Prompt assembly never includes `.env`/secrets — context digest is
  board surface + project entities only; no repo file content in v1.
- `base_updated_at` fencing applies per op; accept-all is one
  transaction — no half-committed batches, no unfenced bulk path.
- Transcript + proposals + decisions are append-only/audited — an
  AI-authored board is fully reconstructable (who asked, what the model
  extracted, who accepted).
- `serve` ops validate target existence + same-board membership; a
  proposal can't wire `serves` to another board's or a tray item.

## Addenda

- Deferred: `/organize` (cluster/zone/dedupe) and `/import` (bulk-paste
  intake) skills; private interview branches (`interview_branches`
  ready); token streaming; per-turn model/token cost display;
  assistant-authored zones with presentation_order; voice/attachments;
  cross-board commands; proposal expiry sweeps; a `meta` column on
  `interview_branches` if run bookkeeping outgrows `role`.
