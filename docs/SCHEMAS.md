# SCHEMAS — sprint-runner data contracts

Companion to `PRD.md`. Draft 2026-10-03.
Every file below is the *contract* — agents must emit exactly these shapes,
the runner lints them **fail-closed** (unparseable structured section →
ticket cannot advance + "doc needs repair" inbox item).

**Conventions:** `schema: 1` on every structured doc/file · timestamps
UTC ISO-8601 · markdown tables have pinned headers/order (shown here) ·
free text only in designated description columns.
**Versioning:** migrate-on-touch — the runner upgrades a doc's schema
when it next writes that ticket (same commit); dormant tickets stay on
their version until revived. No big-bang migrations.

---

## 1. ticket.md — frontmatter

```yaml
---
schema: 1
id: ABC-123                  # stable id; matches folder tickets/ABC-123/
title: Short title
status: imported             # enum below
priority: high               # high | medium | low
repos: [backend, frontend]   # LIST — one branch+worktree+PR per repo
depth: standard              # light | standard | deep — spec-depth tier;
                             # same deliverables, variable thoroughness;
                             # triage recommends, human may override
backend: aider               # optional; default from config
model: openrouter/anthropic/claude-sonnet-4   # optional
source: jira:PROJ-123        # optional: jira: | github:org/repo#N | manual
parent: null                 # set on children produced by a split run
depends_on: []               # ticket ids that must merge before this
                             # one can implement (topological ordering)
forced: false                # true when human overrode a gate
blocked_reason: null         # set with status: blocked —
                             # env | agent | <short text> (a value like
                             # 'blocked: env' would parse as a YAML map)
---
```

**status enum:** `imported, triage, needs-info, escalated, wont-do,
ready, prd-draft, prd-review, prd-approved, design-qa, tdd-draft,
tdd-review, tdd-approved, test-draft, test-review, test-approved,
in-progress, review, changes-requested, approved, pr-open, ci-watch,
merged, reverted, failed, blocked, aborted, split`
(terminal: `merged, reverted, wont-do, aborted, split` — a `split`
parent's work continues through its children)

## 2. prd.md — required sections

```markdown
# PRD — <id>: <title>
## Problem / why
## Requirements (final)
## Acceptance criteria
| ac_id | criterion | verifies-how |
#  each criterion MUST be a checkable statement — Given/When/Then or
#  "when X, then Y must hold". Vague verbs ("works", "handles") fail lint.
## Out of scope
## Open questions (none allowed at approval time)
```

## 3. tdd.md — required sections + file-plan table

```markdown
# TDD — <id>: <title>
## Architecture
## Execution plan            (ordered steps; implement runs in order)
| step | description | verify-with |
## File plan                 (MACHINE-READ — pinned columns)
| file | repo | change | why |
#  a row for a non-code file may start its `change` cell with
#  "untestable:" — exempts that row from coverage; see §4
## Risks / open items
## Addenda                   (appended ONLY by implement agent on deviation)
| ts | planned | did | reason |
```

## 4. test.md — cases + coverage matrix

```markdown
# Test plan — <id>
## Cases
| case_id | title | type | file | covers |
#  type ∈ unit | integration | e2e | manual
## Coverage matrix           (MACHINE-READ — lint-checked)
| item | kind | case_ids |
#  kind ∈ ac | file | workflow ; case_ids comma-separated
#  an `untestable:` file-plan row uses `case_ids: n/a` (lint-exempt)
## Definition of Done         (non-test exit criteria)
| criterion | verified_by |
#  rollout/observability/rollback — e.g. "metric X emitted on success",
#  "migration down-path tested", "flag removed after soak".
#  verified_by = `cmd:<shell command>` (runner executes it as a verify
#  task before merge enables) | `manual` (human attest on S-08/S-09).
#  Merge is blocked until every row's check has run.
```

Lint passes iff every PRD `ac_id` and every TDD file-plan row maps to ≥1
`case_id` — or is a declared `untestable:` row. Fails closed; fake
coverage can't be manufactured to satisfy it.

**Case linkage (machine-verifiable):** every `case_id` must appear
literally in its test file — a `case:<id>` marker in the test name or a
comment, e.g. `// case:c1` or `it("case:c1 retries then succeeds")`.
The runner greps test files for `case:` markers to set `implemented` in
`test-report.json` — planned coverage is verified, not self-reported.

## 5. triage.json — question objects

```json
{
  "schema": 1, "ticket": "ABC-123", "round": 2,
  "spec_lint": {"score": 72, "flags": ["ac2 vague verb: 'handles'",
                "no out-of-scope section"]},
  "suggestions": {"backend": "aider", "model": "openrouter/...",
                  "priority": "high", "depth": "standard"},
  "files_likely_touched": [{"repo": "backend",
                          "file": "internal/etl/worker.go"}],
  "entities_referenced": [{"term": "job", "entity": "IngestionJob",
                           "confidence": 0.9}],
  "risk_summary": "one honest paragraph",
  "self_answered": [{"question": "...", "answer": "...", "evidence": "file:line"}],
  "questions": [{
    "id": "q3", "question": "...", "why": "...",
    "format": "yesno|single|multi|text",
    "options": [{"key": "A", "label": "...", "recommended": true}],
    "default": "A", "allow_other": true,
    "status": "open|answered|skipped",
    "answer": null, "answered_by": "keith", "answered_at": null,
    "auto": false        // true when skipped → default applied
  }]
}
```

## 6. review.json — findings

**File flow:** each specialist pass writes a bare JSON array of
findings to `findings-<pass>.json` (passes may run in parallel — never
append to a shared file). The **runner** merges the four fragments
into the `review.json` envelope below, computing `fingerprint` and
`thread_id` per finding. Agents never emit either.

```json
{
  "schema": 1, "ticket": "ABC-123", "round": 1,
  "passes": ["correctness", "security", "spec-compliance", "test-gap"],
  "findings": [{
    "thread_id": "f-8f3a", "status": "open|fixed|reopened|dismissed|wontfix",
    "fingerprint": {"file": "...", "symbol": "...", "category": "correctness",
                    "line_range": [40, 52], "text_hash": "sha1:…"},
    "severity": "blocker|major|minor|nit|question",
    "category": "correctness|security|perf|style|test-gap|spec-deviation",
    "kind": "spec-bug|code-bug",
    # spec-bug = traced to spec ambiguity/missing requirement → addends
    # the spec doc + feeds spec-quality metrics; code-bug = impl error
    "file": "...", "line": 0, "repo": "backend",
    "body": "...", "evidence": "...", "suggested_fix": "...",
    "confidence": 0.8, "rounds_seen": [1],
    "author": "review", "replies": [{"actor": "human", "body": "...", "ts": "..."}]
  }]
}
```

Fingerprint dedupe across rounds: same `file`+`symbol`+`category` +
overlapping `line_range` → same `thread_id`, `rounds_seen` grows,
status transitions `open → fixed → reopened`.

**Fingerprints are computed by the RUNNER, not the agent** — agents emit
`file`/`line`/`evidence`; the runner derives `symbol` (ctags/tree-sitter
when a repo-map is available, else null), `line_range`, and `text_hash`.
Agent-computed fingerprints would be inconsistent across models/languages
and break dedupe.

## 7. events.jsonl — one JSON object per line

```json
{"v":1,"ts":"2026-10-03T14:22:10Z","ticket":"ABC-123","stage":"review",
 "actor":{"type":"agent|human|runner|system","id":"aider/openrouter-sonnet"},
 "event":"finding_created","run":"003-review",
 "refs":["runs/003-review/review.json"],"data":{},
 "cost_usd":0.12,"tokens_in":41200,"tokens_out":4010,"tokens_cached":30000,
 "usage_source":"reported","duration_s":310,"human_minutes":0}
```

**Event enum (medium granularity):** `imported, status_changed,
run_started, run_finished, run_failed, run_killed, run_paused,
run_resumed, commit, question_asked, question_answered,
question_autoaccepted, doc_drafted, doc_feedback, doc_approved,
doc_repaired, finding_created, finding_fixed, finding_dismissed,
fix_round_started, gate_approved, gate_overridden, claimed, unclaimed,
note_added, pr_opened, ci_failed, ci_green, teammate_comment,
comments_processed, rebase_run, merged, reverted, escalated, blocked,
handoff, resumed, interview_started, ticket_authored, spec_scored,
split_proposed, split_approved, split_materialized, survey_started,
survey_completed, dossier_updated, dossier_edited, gap_reported`

**Internal streams are not events**: `usage_partial` (adapter →
conductor → SSE) and `run_output` chunks update `runs.tokens_*` and
the live monitor in place but are NEVER written here — the ledger
stays at commit granularity.

Events *reference* artifacts via `refs` (relative to ticket dir) — they
never embed transcripts. `tokens_*` fields on `run_finished`/`run_killed`
are the run totals from `usage.json`; `usage_source` ∈
`reported | partial | estimated`. `cost_usd` filled only where the
backend's pricing is token-computable (null e.g. for non-token-priced
billing) — tokens are the universal currency of account, dollars are
derived where honest.

## 8. DEVIATIONS.md (in worktree, collected to runs/<id>/)

```markdown
# Deviations — <id>
| planned | did | reason | file |
```
Plus freeform notes section below the table.

## 9. pr-body.md — required headings (runner assembles PR from it)

```markdown
## Summary
## Acceptance criteria map      (ac_id → where satisfied)
## Deviations                    (or "none")
## Test results                  (from test-report.json)
## Risks / rollout notes
```

## 10. test-report.json (runner-produced, ground truth)

```json
{"schema":1,"ticket":"ABC-123","ts":"…","command":"make verify",
 "cases":[{"case_id":"c1","implemented":true,"file":"…","result":"pass|fail|skip"}],
 "pass_pct":94.1,"planned":17,"implemented":16,"risks":["c4 unwritable: needs staging"]}
```

## 11. Dossier — product knowledge base entry (DB-stored, not a file)

Dossiers live in the DB layer (query + reference class). Two kinds:
`repo` (one per code repo) and `product` (rollup across a product's
repos). Each entry: `scope` (repo|product), `name`, `version`,
`surveyed_at`, `sources_used` (code|docs|screenshots|crawl|tickets|
analytics), `sections` below, plus `human_edits` audit refs.

```markdown
## Architecture map      modules, data flow, integrations, external deps
## Domain model          entities, state machines, business rules
## User workflows        | workflow | persona | path/screens | state |
## Personas              | name | kind (inferred|confirmed) | evidence |
## Docs digest           manuals/FAQs/wikis summarized + source links
## UI map                screens + navigation (screenshots/crawl refs)
## Glossary              domain terms — feeds question quality
## Landmines             fragile areas, forbidden zones, "touch X → also Y"
## Gap report            | gap | kind | evidence | severity |
#  kinds: undocumented-workflow | doc-vs-code-contradiction |
#        untested-flow | doc-rot | dead-screen | missing-persona-info
```

Consumption rule: stage prompts get SCOPED sections (matched to the
ticket's touched area), never the whole dossier — token budget.

## 12. Semantic layer — entities, relations, embeddings (DB-stored)

Meaning lives in the DB (query class), derived + regenerable — never a
second source of truth. Ontology-lite: typed-edge tables, NOT RDF/OWL.

**entities** — one row per thing the domain knows:
`| id | product | kind | name | canonical | aliases | source | evidence |`
`kind ∈ entity | workflow | persona | concept | term | screen`
`source ∈ inferred | confirmed (human) | imported`

**relations** — typed edges:
`| subject | predicate | object | evidence | source |`
`predicate ∈ part-of | calls | owned-by | transitions-to | depends-on |
             synonym-of | documents | tests | contradicts`

**embeddings** — `{object_ref, vector, model}`; objects = tickets,
dossier sections, findings, questions, gaps. sqlite-vec / pgvector.
Used for: prior-art recall, near-dup ticket/finding detection, dossier
retrieval, conflict prediction (tickets sharing entities).

**Taxonomies (controlled vocabularies, versioned):**
- deviation `reason_kind`: `missing-file | wrong-api | spec-ambiguous |
  upstream-change | perf | other` — deviation-rate decomposes into WHICH
  spec-failure kind; the headline metric becomes diagnostic
- question `gates`: `scope | ac-clarification | tech-choice |
  integration | data-model | ux | other` — which ambiguity types recur
- finding `category` + gap `kind`: existing enums, grown as data warrants

**Entity linking** — `triage.json` gains `entities_referenced`
(ticket terms → dossier entities via canonical names + aliases):
touched-file prediction, AC→entity traceability, duplicate-ticket
detection, cross-ticket conflict prediction.

## 13. usage.json — per-run token ledger (in runs/<NNN>-<stage>/)

Every stage run writes one — **required artifact**, never optional.
The per-call ledger is the record; events + DB rows are projections.

```json
{
  "schema": 1, "ticket": "ABC-123", "run": "003-implement",
  "backend": "aider", "model": "openrouter/anthropic/claude-sonnet-4",
  "granularity": "per-call|run-aggregate",
  "totals": {"tokens_in": 41200, "tokens_out": 4010,
             "tokens_cached": 30000, "cost_usd": 0.12,
             "duration_s": 310},
  "calls": [{
    "seq": 1, "ts": "…", "model": "…",
    "tokens_in": 8000, "tokens_out": 900, "tokens_cached": 6000,
    "latency_s": 12.4, "source": "reported|estimated"
  }],
  "source": "reported|partial|estimated",
  "notes": "optional — e.g. 'output estimated: harness reports nothing'"
}
```

**Accounting rules:**
- `tokens_in` is always **exact** — the runner rendered the prompt and
  counts it (local tokenizer). Never estimated.
- `tokens_out` / `tokens_cached` / `cost_usd`: **reported** when the
  harness exposes usage; **estimated + flagged** (`source`) when not —
  a fabricated number labeled `reported` is worse than a null.
- `granularity: per-call` where the adapter can see individual model
  calls (aider's per-message usage); `run-aggregate` = one synthetic
  call row carrying the totals (devin export, silent harnesses).
- `cost_usd` = tokens × backend price table where token-priced
  (OpenRouter); **null** where billing isn't token-based (devin) —
  never synthesize dollars from a non-token pricing model.
- `tokens_cached` = cache-hit input tokens (prompt-caching discounts —
  the honest cost number for agent workloads where cache dominates).
- Missing usage **never fails the run** — `source: estimated` keeps the
  ledger complete through silent harnesses.

## 14. split-plan.md — machine-read decomposition plan (in ticket dir)

Written by the split run; approved at the `split-plan` gate; the
**conductor materializes children mechanically** — there is no second
agent run.

```markdown
# Split plan — <id>
## Children                  (MACHINE-READ — pinned columns)
| child | title | repos | depends_on | covers |
#  child = local label c1..cn (real ids assigned at materialization);
#  depends_on = sibling labels, not ticket ids; covers = parent ac_ids
## Rationale                 one line per boundary
```

The split run also writes `{{TICKET_DIR}}/children/<label>.md` — a full
ticket.md per §1 for each row, with placeholder `id: <parent>-<label>`,
`status: imported`, `parent: <id>`. On approval the conductor reserves
real ids via next-id CAS, rewrites frontmatter (`id`, `depends_on` →
sibling ids), moves drafts to `tickets/<new-id>/ticket.md`, sets the
parent → `split` (`split_materialized` event). On reject, plan and
drafts stay in place and the ticket returns to triage.

---

**Lint rule (all docs):** structured tables must parse cleanly or the
ticket blocks with a `repair` gate item (doc-repair-needed). Human
edits via github.com are welcome — malformed structured sections are
the only thing that stops the machine.
