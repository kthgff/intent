# FEATURES — boards, initiatives, features, projects

Companion to `PRD.md`, `UI-INVENTORY.md`. Status: **draft, decisions
ratified 2026-10-04** (session: 15-question design review; D26 in
TRACKER). This doc is the contract for the idea→production front end:
the board, the entity hierarchy, the synthesis + decomposition runs,
and the DB-only storage pivot.

**Sequencing note:** launch-fixes first (CLI entrypoint, conductor
serving the UI, real `human_minutes` + deviation rate), board work
second. This spec is written as the target state; implementation waves
come later.

## 0. The two pivots

**Storage: DB-only.** The tickets repo is **dropped**. All truth —
entities, docs, events, run artifacts' indexes — lives in Postgres
(D29: Postgres only — PGlite for tests; `storage_url` selects). What this
changes:

- `events.jsonl` → an append-only `events` table (same event enum +
  fields; `seq` orders). `LOG.md` generated per-entity on demand.
- Doc versioning (prd.md v1→v2…) → immutable `doc_versions` rows
  (`subject`, `doc`, `version`, `content`, `created_at`) — git history
  replaced by row history; diffs computed between rows.
- **What is lost (accepted):** github.com visibility, PR-based ticket
  grooming, git-as-exit-strategy. The ledger's audit semantics are
  preserved — append-only events + immutable versions — just relocated.
- Markdown stays the doc *format* (agents still emit SCHEMAS-shaped
  docs) — it's stored in DB rows, not files. Artifact files
  (transcripts, usage.json) may live on disk; DB holds refs, unchanged
  per DB-SCHEMA rules.

**Naming: project.** `workspace` (tickets repo) and `product` (repo
rollup) merge into **project** — one entity: its code repos, docs,
boards, initiatives, features, tickets, dossier. Spec/UI language says
"project"; `workspace` remains the internal physical key on existing
tables/API (rename deferred, no migration). Config: `projects:`
replaces `tickets_repos:` + `products:`.

## 1. Entity model

```
project ─────────────────────────── internal key: workspace
├── boards (named, Postgres)        the idea space + delivery view
├── initiatives                     own prd.md + tdd.md
│     └── features                  own feature.md + test.md + AC slice
│           └── tickets             implement → review → merge
└── tickets (orphans, no feature)   today's pipeline, unchanged
```

| Entity | Parent | Owns | Status enum |
| --- | --- | --- | --- |
| `board` | project | items, zones, filter config | `active`/`archived` |
| `initiative` | project, born of a board | `prd.md`, `tdd.md`, provenance, `priority`, `owner` | triage → …→ `split` → `delivered` \| `closed` \| `discarded` |
| `feature` | initiative | `feature.md`, `test.md`, AC slice, `priority`, `owner`, `depends_on` | same ticket enum minus triage stages |
| `ticket` | feature \| project | existing contract (+`owner`) | existing enum + `verifying`/`released`/`verify_failed` (§8) |

- **Feature = parent with a docs contract.** Unifies with the
  `parent:`/`depends_on`/split-family machinery — no second family
  model. Tickets carry `feature: <id>`; features carry
  `initiative: <id>`. Split of an oversized *feature* produces child
  features of the same initiative.
- **Orphan tickets** stay legal — small work skips the feature tier
  entirely (project-scoped).
- **IDs:** initiatives/features get workspace-counters like tickets
  (`IN-NNNN`, `FE-NNNN` — or `<project>-` prefixes, decided at impl).

## 2. The board

Named canvas per project (many allowed — "Q1 goals", "bug wishes").
Postgres-backed, autosaved. Miro/FigJam-style freeform canvas —
implementation choice (tldraw SDK recommended) is a design-doc detail.

### 2.1 Item types (all LLM-context)

sticky note · text card · document · image · file · link (fetched to
markdown on ingest) · voice note (transcribed on ingest) · zone/frame
· connector · comment · tag

- **Typed stickies** — 6 colors; type chip: `thought | goal |
  ambition | question | requirement | reference` — synthesis weighs
  them differently: `goal`/`ambition` items steer the initiative PRD's
  direction and success criteria (many per board — a board can chase
  several goals; items group under them spatially), `question` becomes
  an open-questions row, `requirement` a hard constraint,
  `thought`/`reference` evidence. The synthesized initiative's goal
  one-liner links back to its source sticky via `provenance` —
  direction is traceable, not paraphrased.
- **Goals (D33)** — goals are *typed stickies*, not board fields, and
  **board-local** (a "Q1 goals" board is itself a goal collection;
  no project-level goal registry). Free-text direction only — no
  metric/target machinery; the human judges whether shipped work
  served the goal. Semantics:
  - **`serves` edges** — a `serves` connector type (and zone
    containment as a visual affordance that writes the same edge) links
    items to goals; `board_items.serves` is the canonical edge synthesis
    and rollups read. One item may serve multiple goals.
  - **Goal-required synthesis** — a synthesize run must have ≥1 goal
    in scope. If none exists, the Q&A *asks the human to state one*
    inline (answer becomes a `source: human` goal sticky) — the
    requirement is a wizard step, not a hard block.
  - **Goal lifecycle** — goal stickies carry
    `active | achieved | abandoned` (extends `board_items.status` for
    goal items); stale goals surface in `board-digest` like stale items.
  - **Live rollup** — the sticky renders a live progress badge
    (served initiatives `shipped` ÷ total, recomputed from events) —
    direction sees delivery, delivery reports to direction.
  - **Agent-authored goals** — allowed in `lane` mode only (suggested
    lane, human promotes); agents never drop goals on the canvas freely.
  - **No unmoored-work audit** — work serving no goal is legitimate
    (exploration, chores); no gate, no badge.

### 2.1a Goals propagation — direction flows downstream (D33)

`serves` is carried on every delivery entity (`initiatives`,
`features`, `tickets` — DB-SCHEMA) as a ref to goal `board_items`
ids; the chain is **inherited, overridable**:

- **Synthesis → initiative**: `initiative.serves` = union of the
  scoped goals + consumed items' serves (provenance records which
  sticky). The initiative PRD's "why" is written from these goal texts.
- **Decompose → feature**: `feature.serves` inherits the initiative's;
  a feature may add (not silently drop) edges.
- **Feature → ticket / split → children**: inherit parent's `serves`;
  a ticket may carry a direct override for surgical work.
- **Non-board-born tickets** (imports, interviews, orphans): triage/
  interview asks "which goal does this serve?" as a wizard question —
  shown only when the project has ≥1 `active` goal and the subject has
  none. Options = the project's active goals + "none/new". Answer writes
  `tickets.serves`; if the subject has a board card, the same edge is
  drawn. A "new" answer drafts a `lane`-mode goal sticky.
- **`{{GOALS}}` prompt token**: the conductor resolves the subject's
  served goal texts (walk chain → serves edges → sticky bodies) and
  injects them into triage, interview, prd, design, testplan, implement,
  and review prompts — every agent works under stated direction, not
  just a spec. Goal-free subjects render `"no stated goal"`.
- **Metrics**: the ledger groups by `serves` — cost per goal,
  idea→merge lead time per goal, deviation rate per goal (PRD headline
  metric decomposes by direction, not just by ticket).
- **Release/retro**: release notes and retro cards group shipped work
  by served goal — the board's "did we move it?" reads itself.
- **`source:` provenance** — `human | agent:<run>` chip; agents may
  write freely (survey gaps, findings, tech-debt); config
  `board.agent_items: free | lane` (lane = 'suggested' zone for
  review-then-accept).
- **Icebox zone** — parked items excluded from synthesis.
- **Capture tray** — `board_items` rows with `board: null` hold
  untriaged captures (CLI `veto add`, `⌘⇧C` modal, `POST /capture`,
  mobile route). Tray items surface in an S-16 dock, drag onto any
  canvas, and are an optional synthesis scope. `feedback` is a further
  item type (production signal → board).
- **Stale items** — `touched_at` tracked; `boards.digest: weekly|off`
  produces a `board-digest` gate + stale-count badge on S-15.

### 2.2 Work layer (delivery view)

Jira-familiar: **kanban columns by status group** laid over the canvas
as a toggleable view. The columns are the shared **pipeline board**
component — the same 5 phases (Backlog·Spec·Build·Review·Done),
attention badges, and validated `drop_targets` as S-01 Home
(`docs/design/s-01-board.md`). S-01 Home is the project-wide instance;
this is the same component scoped by a saved **board filter**:
`project`, `initiative`, `feature`, `goal` (D33), `status`, `priority`,
`orphans-only` — default = "work spawned from this board"
(provenance-scoped).

**Full actions on cards** — cards are live objects: open gate → the
wizard/doc-review surface (embedded or route); approve, answer,
retry, claim — same idempotent actions as the inbox. The board is a
second action surface; inbox remains the unified cross-project one.

### 2.3 Item lifecycle

`open → consumed → shipped` (+ `parked` icebox, `superseded`).

- **Consumed** (by a synthesis run): frozen — immutable, dimmed,
  linked to everything it produced. Edit path = `supersede` (new
  item linking the old). Provenance must not drift — but it must be
  *correctable*: `provenance_amended` events link/unlink items↔ACs
  (S-18 editor). Initiative `discarded` releases items back to `open`
  with a `was: consumed→IN-x` ghost tag.
- **Shipped**: when every descendant ticket reaches `released` (§8 —
  not merely merged), the item lights up — idea visibly became code.

## 3. Synthesis run — board → initiative

New run type `board-synthesize` (prompt `board-synthesize.md`), with a
`scope` param: `board | zone | selection | new-since-last-run | tray`
(default = new-since-last-run on boards that already spawned
initiatives; icebox always excluded). The S-16 Synthesize button is a
split button offering these scopes.

1. **Extract** — serialize the scoped items (text, doc contents, OCR/
   vision on images, transcripts, zone topology, connector hints,
   comments) **plus project context** into run context:
   - **dossier digest** — `context_file` + key S-14 sections
     (architecture, landmines, personas), token-budgeted
     (`synthesize.context_tokens`, ~8k default);
   - **prior-art recall** — semantic match vs existing initiatives/
     features/tickets (`prior_art_recall`, `semantic.*`) → overlap
     list;
   - **open-question memory** — unresolved questions from sibling
     initiatives on the same board.
   Cost preview shown on the confirm ("~N items ≈ $x–y on <model>").
2. **Interview** — ambiguities + prior-art overlaps → S-04 wizard
   questions (same question objects; overlaps phrased as
   "extends FE-2 or new?"). `synthesize.max_questions: 15` default;
   overflow lands as an `## Open questions` PRD section + deferred
   gate item.
3. **Draft** — initiative `prd.md` + **provenance.json**:

```json
{"schema":1, "board":"<board-id>", "run":"<run-id>",
 "ac_map": [{"ac_id":"ac1","items":["it_9","it_14"]}],
 "req_map": [{"section":"Requirements/2","items":["it_3"]}],
 "consumed":["it_1","it_3","it_9","it_14"],
 "serves":["it_5"]}
```

   Consumed items freeze+dim; each AC/requirement cites its sticky
   notes — rendered as "grounded in N items" in doc review.
   `serves` = union of in-scope goals + consumed items' serves →
   written to `initiatives.serves` (§2.1a).
4. **Doc review** — PRD (and TDD after design Q&A) approve via S-06.

Then **decomposition reuses split machinery at both levels**:

- `initiative-decompose` → split-plan listing features (title, repos,
  AC coverage map vs initiative PRD) → human approves → materialize
  `features/` rows mechanically (conductor, no second run) —
  `features.serves` inherits the initiative's (§2.1a).
- `feature-decompose` → split-plan listing tickets → approve →
  materialize tickets `status: imported`, `feature:` set,
  `serves` inherited. Tickets then
  flow the normal pipeline (spec stages may be trimmed per trust
  inheritance, §4).
- **Re-plan** — `replan: true` on either decompose run re-plans
  *unmet* ACs only; output renders as a split-plan v2 diff in S-06;
  terminal children are locked rows. **Re-parent** moves a ticket/
  feature to a new parent via `reparented` event (provenance follows).
- **Manual creation** — initiatives/features can be authored without
  a board (sidebar + menu): blank initiative → `prd-draft` via short
  interview; feature requires a parent initiative or explicit orphan.
- **Cancel cascade** — `wont_do`/`discarded` on initiative/feature →
  explicit choices for children (`wont_do` / keep / re-parent) and
  consumed items (release to `open` vs keep-consumed); never silent.

## 4. Attention budget under the new hierarchy

A 5-feature initiative × 3 tickets can produce 40+ gate items — the
product's promise breaks without controls:

- **`gates: plan-package` is the default for initiative work** —
  combined doc approvals, not per-doc.
- **Batch approvals** — one inbox item can approve a split-plan set or
  all pending feature test plans of an initiative ("approve all 5").
- **Trust inheritance** — an approved initiative PRD/TDD marks
  feature/ticket drafts as *pre-approved context*: downstream doc
  reviews render the delta vs approved context, not the whole doc.
- **Inbox grouping by initiative** — gates cluster under an
  "Initiative IN-7: 4 gates" header so cost stays visible.

## 5. Closing the loop

- **`shipped` item state** — all descendants `released` (§8).
- **Verify stage** — see §8: merged → verifying → released.
- **Retro card** — on initiative `delivered` **or `closed`/`discarded`**
  (partial failure is when it matters most), an agent run writes a
  card back onto the board: what shipped, cost, deviation rate,
  spec-bug patterns, "what we'd spec differently." Source chip
  `agent:retro`.
- **Release notes** — on `delivered`, a run generates
  `release-notes.md` (features shipped, ACs met, PR links, cost, lead
  time) → attached to the initiative + optional `gh release`.
- **Spec-bug → board note** — spec-bugs in a feature's tickets suggest
  a note on the initiative's board (approved, not auto-added —
  `agent_items: lane` path even when free-mode).

## 6. New metrics (S-12 extension)

- **Idea→released lead time** — item `created_at` → last descendant
  `released`. The marketing number. (Idea→merge stays the pipeline
  sub-metric.)
- **Cost per feature / initiative** — summed across descendants.
- **Board yield** — % items consumed → % shipped.
- **Initiative spec score** — rolled-up `spec_score` of children,
  shown pre-decompose.

## 7. New schema surface (draft — lands with implementation)

```sql
boards(id, project, name, filter_config jsonb, archived_at, created_at);
board_items(id, board,          -- null board = capture tray
            kind, type, content jsonb, x, y, w, h,
            source, status,  -- open|consumed|shipped|parked|superseded
            consumed_by, produced_refs jsonb, supersedes,
            touched_at, created_at);
initiatives(id, project, title, status, board, provenance jsonb,
            priority, owner, depends_on jsonb, …);
features(id, project, initiative, title, status, priority, owner,
         depends_on jsonb, …);
-- tickets gains feature_id, owner; events/doc_versions tables replace
-- events.jsonl/doc git-history per §0.
```

API additions (draft): `/boards`, `/boards/<id>/items`,
`/boards/<id>/synthesize`, `/initiatives`, `/initiatives/<ref>`,
`/features/<ref>`, `/capture` (tray/feedback ingress) — same
conventions as existing routes. `/interview` generalizes:
`ticket_ref` → `subject_ref` (IN-/FE-/SR-; same dir-scoped diff rules
per entity). New `verify` gate kind `verify-confirm` + `board-digest`
kind for the stale-item digest. Global `⌘K` search extends to board
items + doc contents (FTS5 over `board_items.content`,
`doc_versions`).

New screens: **S-15 boards list**, **S-16 board canvas**,
**S-17 feature detail** (S-05 anatomy), **S-18 initiative detail**
(S-05 anatomy: docs + features rollup + provenance browser), and
**S-19 quick capture + project tray** (`/capture`, `/tray`, shared
`⌘⇧C` modal). Design
docs: `docs/design/s-15..s-18-*.md`.

## 8. Verify stage — merged → released (D27)

The loop claimed idea→production but ended at `merged`. New statuses
insert post-merge: `merged → verifying → released` (terminal) |
`verify_failed` (→ S-10). The check, tiered:

1. `verify_cmd` on the initiative/project — conductor runs it
   post-merge (health check, smoke suite);
2. else `app_url` smoke — the survey Playwright crawler loads the app,
   screenshots, checks render/console errors;
3. else human — `verify-confirm` gate item ("confirm it works",
   one-click).

Optional `gates.uat: on|off` (default off): when on, `released`
requires the human gate even after a green smoke run. Board item
`shipped` requires `released`. `verifying` renders in the Review
board column; `released` joins Done. v1 may ship manual-gate-only;
automated smoke is a fast-follow.
