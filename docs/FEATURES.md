# FEATURES — boards, initiatives, features, projects

Companion to `PRD.md`, `UI-INVENTORY.md`. Status: **draft, decisions
ratified 2026-10-04** (session: 15-question design review; D21 in
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
(SQLite keeps working for solo dev; `storage_url` chooses). What this
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
| `initiative` | project, born of a board | `prd.md`, `tdd.md`, provenance | triage → …→ `split` → `delivered` |
| `feature` | initiative | `feature.md`, `test.md`, AC slice, `priority` | same ticket enum minus triage stages |
| `ticket` | feature \| project | existing contract | existing enum |

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
  them differently.
- **`source:` provenance** — `human | agent:<run>` chip; agents may
  write freely (survey gaps, findings, tech-debt); config
  `board.agent_items: free | lane` (lane = 'suggested' zone for
  review-then-accept).
- **Icebox zone** — parked items excluded from synthesis.

### 2.2 Work layer (delivery view)

Jira-familiar: **kanban columns by status group** (spec'ing /
implementing / reviewing / done) laid over the canvas as a toggleable
view. A saved **board filter** scopes what shows: `project`,
`initiative`, `feature`, `status`, `priority`, `orphans-only` —
default = "work spawned from this board" (provenance-scoped).

**Full actions on cards** — cards are live objects: open gate → the
wizard/doc-review surface (embedded or route); approve, answer,
retry, claim — same idempotent actions as the inbox. The board is a
second action surface; inbox remains the unified cross-project one.

### 2.3 Item lifecycle

`open → consumed → shipped` (+ `parked` icebox, `superseded`).

- **Consumed** (by a synthesis run): frozen — immutable, dimmed,
  linked to everything it produced. Edit path = `supersede` (new
  item linking the old). Provenance must not drift.
- **Shipped**: when every descendant ticket merges, the item lights up
  — idea visibly became code.

## 3. Synthesis run — board → initiative

New run type `board-synthesize` (prompt `board-synthesize.md`):

1. **Extract** — serialize the whole board (text, doc contents, OCR/
   vision on images, transcripts, zone topology, connector hints,
   comments) into run context.
2. **Interview** — ambiguities → S-04 wizard questions (same question
   objects); human answers feed the draft.
3. **Draft** — initiative `prd.md` + **provenance.json**:

```json
{"schema":1, "board":"<board-id>", "run":"<run-id>",
 "ac_map": [{"ac_id":"ac1","items":["it_9","it_14"]}],
 "req_map": [{"section":"Requirements/2","items":["it_3"]}],
 "consumed":["it_1","it_3","it_9","it_14"]}
```

   Consumed items freeze+dim; each AC/requirement cites its sticky
   notes — rendered as "grounded in N items" in doc review.
4. **Doc review** — PRD (and TDD after design Q&A) approve via S-06.

Then **decomposition reuses split machinery at both levels**:

- `initiative-decompose` → split-plan listing features (title, repos,
  AC coverage map vs initiative PRD) → human approves → materialize
  `features/` rows mechanically (conductor, no second run).
- `feature-decompose` → split-plan listing tickets → approve →
  materialize tickets `status: imported`, `feature:` set. Tickets then
  flow the normal pipeline (spec stages may be trimmed per trust
  inheritance, §4).

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

- **`shipped` item state** — all descendants merged.
- **Retro card** — on initiative `delivered`, an agent run writes a
  card back onto the board: what shipped, cost, deviation rate,
  spec-bug patterns, "what we'd spec differently." Source chip
  `agent:retro`.
- **Spec-bug → board note** — spec-bugs in a feature's tickets suggest
  a note on the initiative's board (approved, not auto-added —
  `agent_items: lane` path even when free-mode).

## 6. New metrics (S-12 extension)

- **Idea→merge lead time** — item `created_at` → last descendant
  merge. The marketing number.
- **Cost per feature / initiative** — summed across descendants.
- **Board yield** — % items consumed → % shipped.
- **Initiative spec score** — rolled-up `spec_score` of children,
  shown pre-decompose.

## 7. New schema surface (draft — lands with implementation)

```sql
boards(id, project, name, filter_config jsonb, archived_at, created_at);
board_items(id, board, kind, type, content jsonb, x, y, w, h,
            source, status,  -- open|consumed|shipped|parked|superseded
            consumed_by, produced_refs jsonb, supersedes, created_at);
initiatives(id, project, title, status, board, provenance jsonb, …);
features(id, project, initiative, title, status, priority, …);
-- tickets gains feature_id; events/doc_versions tables replace
-- events.jsonl/doc git-history per §0.
```

API additions (draft): `/boards`, `/boards/<id>/items`,
`/boards/<id>/synthesize`, `/initiatives`, `/initiatives/<ref>`,
`/features/<ref>` — same conventions as existing routes.

New screens: **S-15 boards list**, **S-16 board canvas**,
**S-17 feature detail** (S-05 anatomy); initiative detail = S-05
variant. Design docs: `docs/design/s-15..s-17-*.md`.
