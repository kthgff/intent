# PRD — sprint-runner (working name)

**Status:** Draft v2 · **Author:** Keith + Devin · **Updated:** 2026-10-03
**Reference implementation:** `run-tickets.sh` — working v0 bash prototype,
verified end-to-end with a stubbed agent (priority ordering, repo resolution,
branch creation, prompt rendering, status transitions, blocked path).

---

## 1. Problem

**Code is cheap now; judgment isn't.** LLM agents write implementations
faster than humans can evaluate them — the bottleneck moved upstream, to
requirements, design, and verification. Yet the specs feeding agents are
thin: a ticket, a prompt, and hope. Engineers spend their scarce attention
fixing agent output downstream instead of shaping agent input upstream —
where a precise AC, a correct TDD, or a caught ambiguity is worth dozens of
downstream fixes. There is no tool that (a) helps humans produce specs
rigorous enough to *steer* agents, and (b) verifies the output against
those specs — which is the work that actually decides whether
agent-authored code ships well.

## 2. Product

**The bet: trust, not generation, is the bottleneck.** sprint-runner moves
engineering attention upstream — AI-assisted requirements, design, and
test planning produce specs rigorous enough to *drive* implementation;
agents write the code; the machine proves the spec held. The spec pipeline
is the product; orchestration is what makes it executable.

Pitch: *"Your agents write the code; sprint-runner proves it — spec-gated
implementation, independent-model review, and a complete audit trail per
ticket, ending in a PR a human actually trusts."*

A **local engine with a web-served UI**: the conductor (babysitter
process) serves the full app over HTTP on localhost, and the desktop
application is a thin shell wrapping that surface (Tauri preferred —
lighter, fits a process-spawning tool; Electron acceptable). The engine
CANNOT be cloud-hosted — worktrees, agent CLIs, and detached runs are
local-machine operations; "desktop app" is the delivery wrapper for
presence (dock icon, badge counts, notifications, launch-on-login), not
an architectural commitment. `sprint-runner daemon` headless serves the
identical UI in any browser; cloud multi-tenant SaaS is deferred — it
inverts the "everything stays on your metal" trust model. Shepherds
tickets from ingestion to merged PR:

```
[survey] on repo add: deep investigation → product dossier in the
         knowledge base (DB) — architecture, workflows, personas,
         docs digest, UI map, gap report — feeds every stage below
[author] in-app interview (AI interrogates a rough idea → well-formed
         ticket) — same wizard machinery as triage — OR
[ingest] Jira / GitHub Issues / Linear / manual MD → normalized ticket MDs
       → committed to a configured tickets repo (org/<team>-sprint-tickets)
  → imported
  → [spec-lint] mechanical spec-quality score — vague ACs, missing scope,
    unverifiable criteria flagged BEFORE tokens are spent
  → [triage] read-only agent run (+ prior-art recall from the ledger):
    clarifying questions + repo/backend/model/depth suggestions +
    files-likely-touched, appended to the ticket
  → needs-info ⇄ humans answer in the desktop UI; answers commit back
    into the ticket MD
  → [split] oversized tickets → agent-proposed sub-tickets + dependency
    edges → batch-processed as a family
  → ready → [implement] agent backend → branch + commits + pr-body.md
  → [review] deep LLM review → structured comments (review.json)
  → GitLab-style review UI; human notes feed back to the agent;
    re-review until human approves
  → [open] push + gh pr create
  → [shepherd] watch CI; feed failures + teammate PR comments to agent
  → merged = done
```

**The tickets repo is the source of truth** (post-import snapshot semantics):
a configurable git repository — one per team/product, set via `tickets_repo`
in config. It gives visibility on github.com, PR-based ticket grooming, a
commit-per-status-flip audit trail, and free permissions. The runner/app
clones it; status transitions are machine commits pushed back.

**It is also the transaction log.** Each ticket is a folder carrying its
entire replayable history:

```
tickets/<id>/
  ticket.md          # intake + triage + Q&A transcript
  prd.md  tdd.md  test.md    # versioned — git history = feedback rounds
  LOG.md             # human-readable play-by-play for github.com
  events.jsonl       # append-only machine ledger:
                     #   {ts, stage, actor(agent|human|runner), event, refs[]}
  runs/<NNN>-<stage>/prompt.md, transcript.md, usage.json, <stage outputs>
```

Every prompt, answer, run, review round, and merge is committed — the
ticket folder is a complete replayable case study. `LOG.md` is
**generated from `events.jsonl`** — single source, never maintained
alongside (no drift). Machine commits do **pull-rebase-retry** so human
edits on github.com never collide with ledger writes.
`events.jsonl` event fields include `cost_usd`, `tokens_in`/`tokens_out`/
`tokens_cached`, `duration_s`, `human_minutes` — ROI metrics are schema
fields from day one.
(`human_minutes` is captured as **gate dwell** — gate-surfaced →
gate-cleared timestamps — reported with an honest idle-time caveat, not
fake precision.) This ledger is a first-class asset, not a by-product:
metrics substrate and a prior-art corpus for triage — it survives the
pipeline itself.

**Requirement — per-ticket token accounting.** Every run writes a
`usage.json` ledger (per-call where the harness exposes calls,
run-aggregate otherwise) and every ticket carries input/output/cached
totals across its full lifecycle — interview and survey through
shepherd. Rules: `tokens_in` always exact (we render the prompt);
`tokens_out`/cache reported where the backend exposes usage, estimated-
and-flagged where it doesn't; `cost_usd` computed only where pricing is
token-based (OpenRouter) — null for non-token billing (devin), never
synthesized. Tokens are the universal currency of account; dollars are
derived where honest. Live per-message usage streams to the run monitor
where the adapter can parse it. See SCHEMAS §13 + ADAPTERS usage
contract.

**Headline metric: deviation rate.** Addenda rows + DEVIATIONS entries
per ticket — how often reality disagreed with the spec. A zero-deviation
merge means the TDD was right. Spec quality is measurable from day one;
the ledger is also institutional memory (decision history compounds).
**Sanitizer**: a named scanner (gitleaks or trufflehog) runs
**fail-closed** — a scan error blocks the commit rather than warning —
and prompts instruct agents to never print env/secrets. Runner commits
under a bot identity.

### Agent layer is pluggable

| Backend | Provider/key | Status |
| --- | --- | --- |
| **Devin CLI** | Devin account | ✅ v0 built & verified |
| **BYOK → Aider via OpenRouter** | `OPENROUTER_API_KEY` | 🔲 v1 target — only BYOK provider for now |
| Other agent CLIs (claude, codex, goose, opencode, Gemini) | their own auth | 🔲 later, via same adapter |

**Adapter contract** (what the runner needs from any backend):
run a rendered prompt non-interactively in a repo directory → produce
commits on the ticket branch → report exit status. **The runner owns all
environment-touching steps**: push, `gh pr create`, test re-runs, and
collecting artifacts (`pr-body.md`, `DEVIATIONS.md`, …) into `runs/<id>/`
— so backends that can't write outside the repo still conform.
Each backend declares **capability flags** in config —
`can_exec`, `can_write_outside_tree`, `has_gh` — which reshape the
prompt (instruct artifacts to absolute `runs/` paths only when
`can_write_outside_tree`) and tell the runner what to collect vs.
synthesize from the worktree.

## 3. Users

Potential product/OSS — not just a personal script. Implications: real
packaging/install path, layered config, pluggable backends, a review UI
that is the centerpiece rather than an afterthought.

## 4. Configuration (layered)

```
~/.config/sprint-runner/config.yaml      # global: backend, model, keys
<tickets-repo>/.sprint-runner/config.yaml # per-tickets-repo overrides
<tickets-repo>/.sprint-runner/.env        # secrets — never committed
ticket frontmatter backend:/model:        # optional per-ticket override
```

User configures *which backend* and *which key*; tickets may override.
Full field-level spec in `SETTINGS.md` — YAML, precedence
frontmatter > tickets-repo config > global > defaults, secrets only via
`.env`. The `sprint` concept is dropped: tickets live flat in the repo;
shared context moves to `products.<p>.context_file` (`{{CONTEXT_MD}}`).
Settings include: `main_model`/`review_model`, `gates`
(full|plan-package|minimal), merge strategy, per-stage timeouts,
worktree root, `storage_url`, backend capability flags, repo cards
(auto-probed + execute-verified), notifications.

## 5. Ticket format

```markdown
---
schema: 1
id: ABC-123
title: Short title
status: imported            # see state machine below
priority: high              # high | medium | low
repos: [backend]            # LIST — cross-repo tickets are common;
                            # one branch+worktree+PR per repo
backend: aider              # optional; default from config
model: openrouter/anthropic/claude-sonnet-4   # optional
source: jira:PROJ-123       # optional
---

## Description / ## Acceptance criteria / ## Notes
```

All structured formats (docs, JSON artifacts, events) are specified in
`SCHEMAS.md` — agents emit exactly those shapes; the runner lints them
fail-closed.

## 6. Status state machine

```
imported → triage → needs-info ⇄ (rounds, capped at 3)
                        ↘ escalated — returned to author w/ findings
                        ↘ wont-do — terminal, human-killed
           ready(forced) — human override, flagged in ticket
needs-info → prd-draft ⇄ prd-review → prd-approved
prd-approved → design-qa ⇄ (technical Q&A, same wizard) → tdd-draft
             ⇄ tdd-review → tdd-approved
             → test-draft ⇄ test-review → test-approved
           → in-progress → review → changes-requested ⇄ review
           → approved → pr-open → ci-watch → merged
           ↘ failed / blocked (env) — retryable, picked up on next run
           ↘ aborted (killed/timed out) · reverted (post-merge) — terminal
```

(The full sentinel → status transition table — what fires each arrow —
lives in CONDUCTOR.md.)

Every artifact is **stage-gated**: analyze → Q&A → draft → human
review/feedback → approve → next stage. The wizard machinery is reused
for each Q&A phase (requirements questions for PRD, technical questions
for TDD).

**Gate modes** (`gates` setting — the human-attention budget is tunable,
not fixed): `full` = every doc gated (default, up to ~7 touchpoints);
`plan-package` = PRD+TDD+test reviewed as ONE combined approval (~40%
fewer touchpoints); `minimal` = requirements Q&A + final code review
only.

**Spec-depth tiers** (`depth` — orthogonal to `gates`: depth controls
*investigation thoroughness*, gates control *approval ceremony*):
`deep` = exhaustive analysis (alternatives, risk register, edge cases,
cross-repo mapping) for architectural/high-risk tickets; `standard`
(default) = the pipeline as specified; `light` = same deliverables —
PRD/TDD/test.md still produced and gated — but shallower investigation
and slimmer docs, for small/low-risk tickets. Triage recommends a tier
from ticket size/risk; the human can override; `{{DEPTH}}` is injected
into stage prompts so agents calibrate effort.

### Document pipeline — the per-ticket artifact set

Each ticket in the tickets repo carries:

| File | What it is | Author |
| --- | --- | --- |
| `tickets/<id>/ticket.md` | Intake: original ask + triage findings | importer/human + triage agent |
| `tickets/<id>/prd.md` | Product requirements: what + why, final ACs, scope boundary | agent, after requirements Q&A; human-approved |
| `tickets/<id>/tdd.md` | Technical design: architecture, ordered execution plan, **file-by-file change list with rationale**, risks/open items | agent, after technical Q&A; human-approved |
| `tickets/<id>/test.md` | Test plan: every AC/change/workflow → named test cases + machine-readable **coverage matrix**; no code, plan only | agent, post-TDD; human-approved (same gate) |

- **Requirements Q&A** (the needs-info wizard) must gather everything the
  PRD needs — the PRD is drafted only when its inputs are complete, then
  human-reviewed/approved before design starts.
- **Design stage** runs a second, *technical* Q&A (same wizard UX — "which
  worker pool?", "extend `JobBuilder` or new class?") before drafting the
  TDD; TDD also goes through human approval.
- **TDD is the implement spec** — the implement prompt injects the TDD and
  instructs faithful execution; the raw ticket becomes reference context.
- **TDD drift** = proceed + flag: the agent deviates minimally, documents
  every divergence in `pr-body.md` and a committed TDD addendum. Addenda
  are **first-class citizens** — the review page shows them as a
  dedicated section so "approved doc + agent amendments" is never
  mistaken for "the approved doc."
- **Test stage**: draft test plan → **mechanical completeness lint**
  (parse matrix; every PRD AC + TDD file-change must map to ≥1 case ID —
  an incomplete matrix never reaches human review. Honest scope: it
  proves a case *name* exists per item, not that the case is real — an
  optional reviewer-model **plausibility spot-check** can sample claimed
  coverage) → human approve → implement.
- **Test order**: cases written alongside code (no strict red-green); all
  planned cases must exist by end of implementation.
- **Test results**: the runner independently re-runs the repo-card test
  command and produces `runs/<id>/test-report.json` (per-case
  implemented?, pass/fail/skip, pass %, risk flags) — ground truth, not
  agent self-report. Rendered as a panel on the code-review page; the
  human picks **"send back to fix"** (failures → fix run) or **"approve"**
  (documented failures ride in pr-body). Done is the human's call; the
  report is the contract.

### Implementation stage

The implement prompt is **vendor-portable markdown** — same package feeds
devin, aider+OpenRouter, or future backends:

- **Layered spec package**: must = TDD file-plan + test-plan cases + repo
  card; should = PRD ACs + repo map; reference-on-demand = triage
  transcript, ticket body. Small/weak models get the tight version to
  protect context budget.
- **Ordered execution, per-step commits**: work the TDD plan in order;
  commit at each logical checkpoint (bisectable, resumable, story-readable
  diffs). Verify per step — narrowest relevant check after each change.
- **Deviation fence**: minimal deviations only when the TDD is impossible;
  every deviation logged in `DEVIATIONS.md` (`planned X → did Y, because
  Z`); never widen the diff beyond the TDD file list.
- **End-of-run ritual**: full suite + lint green → self-review diff vs
  TDD file list → cross-check every planned case exists → write
  `pr-body.md` (summary, AC→impl map, deviations, risks). All outputs are
  files with required formats.
- **Sentinel contract (all stages)**: the LAST non-empty line of output
  must be exactly `SENTINEL: <value>`; the runner parses only that final
  line — a `DONE` echoed mid-transcript or inside a code comment can't
  fake an outcome.
- **Resume-aware**: prompt starts with "check branch for existing commits,
  continue where the plan stopped" — a crashed run doesn't redo work.
- **Model as retry dimension**: a failed run on a cheap model retries once
  on a stronger model before `failed` (same escalation ladder as triage).
- **Code repos** = configured in settings (the repos.conf concept graduates
  to a settings panel: N code repos + tickets repo + backend config).
  Feature branch `ticket/<id>` per ticket.
- **Parallelism**: full parallel — tickets may be at any stage
  concurrently; same-repo implementations get isolated **git worktrees**
  (sibling dir convention `<repo>.worktrees/<id>`, cleaned up on
  merge/fail; merge ordering handled by git/CI at PR time, not the
  scheduler).
- **Backend/model (MVP)**: one global config — Aider+OpenRouter **or**
  Devin + a model picker. Per-stage routing is a designed-in seam, deferred
  post-MVP.

Runner owns transitions via frontmatter rewrite, committed and pushed to
the tickets repo. `merged` is terminal; `done`/`merged` skipped on re-runs
(`--force` overrides).

### Storage architecture — three data classes, two stores

Data is split by *who owns it and who queries it*:

| Store | Data class | Contents |
| --- | --- | --- |
| **git** (tickets repo) | Approval + audit | tickets, PRDs, TDDs, test plans, status transitions, events.jsonl — things humans review and the law of the pipeline |
| **DB** (SQLite solo / Postgres team) | Coordination | leases, heartbeats, live runs, presence, notifications |
| **DB** (same store) | Query + reference | **dossiers, gap reports, prior-art index, transcripts, ticket/repo projections, event projections, metrics** — machine-written, machine-queried, regenerable |

Key rule: git keeps everything with *approval/audit semantics* (humans
review diffs); the DB keeps everything *query-oriented or regenerable*
(dossiers can be re-surveyed; projections can be rebuilt). The ledger
still records the runs that produced every DB artifact.

- **Leases** (`ticket+stage+attempt`, TTL + heartbeat): a stage-run can't
  start without holding its lease — prevents duplicate runs across
  installs pointing at the same tickets repo.
- **Run registry** (live process state, heartbeats), **notifications**,
  **presence** — all ephemeral.
- **Queryable event index** — a materialized view of `events.jsonl` for
  metrics/UI queries. **Rebuildable from the ledger; never a source of
  truth.** Nuke it, replay, done.
- Backends: SQLite in-app (solo) · Postgres in daemon mode (team) — same
  schema, `storage_url` in config. Zero-infra fallback for shared queues
  without a daemon: git-ref CAS (`push refs/locks/<ticket>-<stage>` —
  atomic, one winner). **Human-gate items get the same protection** —
  claiming via DB lease or `refs/locks/claims/<ticket>-<gate>` — so two
  installs don't collide on the same wizard; without this, shared-queue
  MVP is scoped to single-human.
- Failure signature to instrument: overlapping `run_started` events for
  the same ticket+stage = a fencing leak.

### Authoring & ingestion

- **Interview mode** (the upstream entry point — most tickets are
  authored in-app): a human types a rough idea; the agent interrogates it
  through the SAME wizard machinery as triage (structured questions,
  recommended options, accept-all, same anti-spin guards) and writes a
  well-formed `ticket.md` straight into the tickets repo. Also runs as
  "deepen this ticket" on a thin imported one. The wizard's job in both
  modes: turn vague intent into implementable spec.

### Knowledge base — the product dossier (the intelligence layer)

Repo cards know *how to run* a repo; nothing in a pipeline knows *what
the product is*. The survey fixes that: a deep investigation run type
that produces a durable **dossier** — the substrate every stage prompt
draws on. This is what turns questions from generic ("what should this
do?") into domain-aware ("does the badge poll respect the 30s SLA your
FAQ promises?").

**Dossier contents** (per SCHEMAS.md §11): architecture map (modules,
data flow, integrations) · domain model (entities, state machines,
business rules) · **user workflows** (happy paths + edge flows, mapped
to real screens) · **personas** (agent-inferred from roles/permissions/
docs → human-corrected) · docs digest (manuals, FAQs, wikis summarized
+ linked) · UI map (screens + navigation, from screenshots and
Playwright crawl) · glossary · landmines (fragile areas, forbidden
zones, "don't touch X without Y") · **gap report**.

**Sources** (pluggable, everything supported): code (inferred
architecture/workflows) · repo docs + provided files (manuals, FAQs,
ADRs, API specs — MD/PDF) · **screenshots** (vision-capable model maps
the real UI surface) · **Playwright crawl** of a running app (maps real
screens + nav firsthand) · support tickets / known-bug lists /
analytics (optional — richest user-pain signal).

**Granularity**: per-repo dossiers (architecture, conventions,
landmines) + a **product rollup** dossier (workflows, personas, docs)
spanning the repos of a `products:` config entry — users experience
products, not repos.

**Production**: `survey` run type — runs on repo add (with the
repo-card probe), on **manual sync** (admin screen button), and on a
**scheduled re-survey** (cron-ish, `survey_refresh: weekly` default —
cadence TBD). Incremental update-on-merge is designed-for, post-MVP.

**Consumption**: the runner injects scoped dossier sections into stage
prompts — `{{DOSSIER}}` in triage/interview (questions get domain-
aware), design (fits real architecture), testplan (cases derived from
*real user workflows*, not just file coverage), review (checks against
documented behavior). Scoped sections by touched area — never the whole
dossier (token budget). **Graceful degradation**: while a survey is
still running, `light`/`standard` tickets flow with `dossier: pending`
(flagged on the ticket); `deep`-tier tickets park until the dossier
exists — the tickets that need it most wait for it.

**Gap report** (report-only): undocumented workflows, FAQ-vs-code
contradictions, untested flows, doc rot, dead screens → a first-class
dossier section humans review in the KB screen. Gaps inform triage
questions; they do NOT auto-generate tickets.

**Human correction**: dossiers are agent-written but human-correctable
in the KB screen — edits are DB writes + ledger events. Same ethic:
agent proposes, human disposes.

**Semantic layer** (SCHEMAS §12): beneath the prose dossier sits a
typed-edge knowledge structure — entities (canonical names + aliases),
relations (`part-of`, `calls`, `transitions-to`, `documents`,
`contradicts`), and controlled taxonomies (deviation `reason_kind`,
question `gates`, finding/gap enums). Local embeddings (sqlite-vec/
pgvector — free, private, no API spend) power prior-art recall,
near-dup ticket/finding detection, dossier-section retrieval, and
conflict prediction. Effect: questions get domain-aware ("when you say
'job' — `IngestionJob` or `SyncTask`?"), deviation-rate decomposes into
WHICH kind of spec failure occurred, and the ledger becomes queryable
by meaning, not just strings. Deliberately ontology-LITE — typed-edge
tables, not RDF — and derived/regenerable like all DB data.

### Spec quality machinery (the upstream product)

- **Spec linter** (mechanical, zero tokens, runs pre-triage): flags
  vague verbs ("handle properly", "should work"), unverifiable ACs,
  missing scope boundary, oversized touched-files estimate → emits a
  `spec_score` + flags into `triage.json`; surfaced in the inbox so the
  worst specs are groomed first. Leading indicator where deviation rate
  is the lagging one.
- **Verifiable ACs**: criteria are written as checkable statements
  (Given/When/Then or "when X, then Y must happen") — structure where it
  pays, freeform prose everywhere else. The coverage matrix then maps a
  real contract, not a wish.
- **Definition of Done**: `test.md` gains a DoD section — rollout,
  observability ("how will we know this works in prod"), rollback/
  migration-reversibility criteria — checked before merge is enabled.
- **Spec-bug feedback loop**: review findings are tagged `spec-bug`
  (traced to spec ambiguity/missing requirement) vs `code-bug`;
  spec-bugs addend the spec doc AND feed the spec-quality metrics —
  closing the loop between what the code review finds and how the
  pipeline's specs improve.
- **Prior-art recall**: the runner injects `{{PRIOR_ART}}` into triage/
  design prompts — similar past tickets (matched by repo + touched-file
  overlap), their deviations, and which questions mattered. v1 = grep/
  file-overlap matching; embeddings later. The ledger learns.
- **Auto-split** (`split` run type): an oversized/escalated ticket →
  agent proposes child tickets with `parent:`/`depends_on:` frontmatter
  → human approves the split plan → children enter `imported` and are
  processed topologically (parallel where independent, max
  `split_max_children`). Decomposition is a capability, not an
  escalation.

### Importing (external sources)

- **Importer adapters**: `jira` (`--jql`/sprint picker, AC extraction),
  `github` (`--repo --milestone`; fills `repo:` for free), `linear`/others
  later, `--csv` catch-all. Contract: tracker → `[]NormalizedTicket` → MD
  emitter.
- **`source:` frontmatter** (`jira:PROJ-123` / `github:org/repo#42`) —
  enables PR-body `Closes org/repo#42` auto-close freebie and future
  write-back.
- **Re-import = snapshot update**: refreshes description fields, never
  clobbers `status:`.
- **Triage stage**: read-only agent run appends `## Triage` (questions,
  suggestions, touched-files) to the ticket; humans answer in-app; answers
  commit back. Tickets are not implementable until `status: ready`.
- **Wizard Q&A loop**: structured question objects (`question`, `why`,
  `format`, `options[]`, `default`, `allow_other`) in
  `runs/<id>/triage.json`; rendered transcript appends to `## Triage` per
  round. Human answers → commit → re-triage → `ready` | smaller batch |
  `escalated`. Questions form a tree (answers unlock follow-ups).
- **Answer formats**: `yesno | single | multi | text` — opinionated
  defaults are MANDATORY (the agent proposes, the human disposes); options
  carry a `recommended` marker; "Other…" escape hatch always present;
  free-text only when genuinely open-ended. Skip = accept default;
  "Accept all recommendations" = one-click pass through the wizard.
- **Voice input**: mic button on text fields — **v1 = the shell's
  webview speech API** (Chromium under Electron, WKWebView under Tauri;
  prefer on-device recognition where the webview supports it). No paid
  STT, no bundled models — only revisit if stock support falls short.
  Raw transcript → LLM cleanup pass normalizes technical terms
  (`"app nav dot t-s-x"` → `AppNav.tsx`) into a structured answer.
- **Anti-spin guards**: ≤3 human rounds → `escalated` (returned to author
  with findings); ≤10 total questions (sprawl = broken ticket); convergence
  detection (no checklist items flipped green → escalate early); one
  stronger-model retry before escalating. Human bail-outs anytime:
  `ready (forced)` override or `wont-do`.
- **Triage self-answers factual questions** by reading the target repo —
  only genuine judgment/product calls escalate to `needs-info` for a human.
- **The `ready` contract**: verifiable ACs + stated scope boundary + repo
  card verified + human questions answered + pre-flight green.
- **Repo card** (per-repo config): test/lint/build commands, forbidden
  paths, key dirs — verified by triage once, injected into implement/review
  prompts. Optional **repo map** (tree-sitter signature dump) for cold-start
  grounding.
- **Pre-flight gate**: clean tree AND test suite green on base commit before
  `in-progress`; broken main → `blocked` + `blocked_reason: env`
  (env-failure distinct from
  agent-failure in the taxonomy).
- Ticket *content* changes go through PRs on the tickets repo (human
  grooming); status flips are direct machine commits.

## 7. Review pipeline (the differentiator)

1. Agent finishes → commits on `ticket/<id>` + `pr-body.md` +
   `DEVIATIONS.md`.
2. **Deep review = multi-pass specialists** — separate focused runs
   (correctness, security, spec-compliance, test-gap) each emitting
   findings merged into one `runs/<id>/review.json` (schema in
   `SCHEMAS.md` §6 — fingerprints are computed by the **runner**, not
   the agent, for reliable cross-round dedupe). The spec-compliance
   pass is partly mechanical: the runner itself diffs the TDD file-plan
   against `git diff --name-only`; the LLM pass only judges whether
   logged deviations are justified and minimal. Reviewer model =
   separate `review_model` setting (recommend different family than
   implementer — no shared blind spots).
3. **Issues → severity-gated fixing**: `blocker`/`major` findings
   auto-queue a fix run; `minor`/`nit`/`question` findings batch to the
   Issues tab for human triage (accept/dismiss/wontfix). Rationale:
   auto-fixing false-positive nits churns working code — every fix is a
   chance to break something, and LLM nits carry a real FP rate.
   Auto-fix rounds capped at **~2**; surviving threads → human.
   **Dismissal cap**: a fix run may self-dismiss at most
   `fix_dismissal_cap` findings (default 2) as not-real — beyond that all
   remaining findings escalate to the human; an agent being corrected
   can't overrule the corrector wholesale.
4. **Full re-review every round** — all specialist passes on the whole
   accumulated change (cost dial = `review_model` tier).
5. **Clean review still requires human approve** → push + `gh pr create`.
   The final stamp is always human.

### Review page (GitLab-style, in the desktop app)

- **Header brief**: diffstat (files, +/−, source:test ratio, new deps) ·
  AC traceability (each PRD AC → verified + code/test links) · spec
  compliance (TDD file list vs actual diff, DEVIATIONS.md cross-check) ·
  test-report.json panel (ground-truth suite re-run) · risk register
  (migrations, API breaks, security surface, perf, data-loss, rollback) ·
  tech-debt delta (TODOs, duplication, hotspots) · highlights · commit
  story vs TDD order.
- **Changes tab**: file tree, side-by-side/unified diff, inline comment
  threads anchored to lines (open/resolved), human comments anywhere —
  human comments also feed fix runs.
- **Issues tab**: every finding = a thread card — severity badge,
  category, `file:line` anchor that jumps into the diff, evidence +
  suggested fix, confidence, status, reply thread (human↔agent discussion),
  batch "send to fix".
- **Test-results panel**: per-case implemented?/pass/fail, pass %, risks —
  with "send back to fix" / "approve" actions on the page.

## 8. Post-PR lifecycle (full shepherd)

- Poll PR checks + review comments every `shepherd.poll_interval_s`;
  check failures → `ci-fix` run, new comments → `comment-fix` run —
  same branch, both bounded by the cycle cap. Human can pause/inspect
  via the UI at any point. Per-PR state (pr/ci/merge) lives in
  `ticket_repos`; `merged` only when all repos' PRs merge.
- **Shepherd cycle cap**: teammate-comment → fix cycles are capped at
  `shepherd_max_cycles` (default 5) per PR — a chatty thread can't burn
  tokens forever; the human takes over past the cap.
- **Spend caps — dual**: `spend_cap_usd_per_ticket` AND
  `tokens_cap_per_ticket` (either fires the kill-switch) plus
  review-round caps bound the cost of LLM-reviewing-LLM — tokens bound
  the backends whose billing isn't dollar-visible (devin). The ledger
  records actual spend so budgets are evidence-based.
- **Rebase run type**: when an earlier same-repo merge conflicts with a
  pending ticket branch, the shepherd rebases onto main, re-runs the
  suite, and pushes — merge ordering is a run, not a punt to git/CI.
- **Abort/kill**: every in-flight run has a per-stage timeout and a kill
  switch — kill the process, preserve the worktree, mark the ticket,
  log the event.
- **Mid-flight change detection**: ticket files hashed at each stage
  boundary; if `ticket.md` changed upstream since the spec was built,
  flag stale-spec → optional re-triage instead of implementing stale
  requirements.
- **Notifications**: desktop notifications + badge counts for every gate
  awaiting human action — the pipeline is async and hours-long;
  attention must be routed, not polled.
- **Human handoff**: any ticket can be handed to a human mid-flight —
  worktree + branch preserved, handoff summary written to the ticket.
- **Merge is a button in the app** — `gh pr merge` (strategy from settings,
  default squash), enabled when checks are green and every `verified_by`
  DoD row has run (`cmd:` rows as verify tasks, `manual` rows as human
  attest). Merge → status `merged` + SHA/PR URL written to
  events.jsonl + frontmatter → worktree cleanup → final log entries
  committed. Never auto-merges in v1.
- **Post-merge revert**: `reverted` status + revert run type for merged
  PRs that break prod — the ledger records the whole arc.
- Terminal states: `merged`, `reverted`, `wont-do`, `aborted`.

## 9. Functional requirements (v0 engine — built)

Serial, priority-ordered execution; `repos.conf` (name→path); clean-tree
preflight (else `blocked`); branch `ticket/<id>`; rendered prompt template
with sprint.md injected; `--dry-run/--ticket/--max/--force/--sprint`;
per-ticket `runs/<id>/` audit trail (prompt, log, export, sessions,
pr-url/blocked/failed).

## 10. Non-functional

- **Security**: **`permission_mode: smart` is the shipped default** —
  bypass is opt-in only. Smart-mode stalls on risky ops surface as
  timeouts → human attention, not silent damage. Clean-tree + branch
  isolation + transcripts; secrets only via env/.env, never in tickets
  or prompts;
  committed artifacts pass a **fail-closed** secrets scan (gitleaks) —
  scan failure blocks the commit; prompts instruct agents never to print
  env values.
- **Cost**: serial self-limits; `--dry-run`/`--max`; per-ticket `model:`
  for cheap-model routing; BYOK = user's own OpenRouter spend.
- **Auditability**: every run leaves prompt + transcript + review.json +
  outcome on disk.
- **Extensibility**: new backends = one adapter; new review UIs read the
  same runs/ data.

## 11. Milestones

- **M0 ✅** — bash reference runner + Devin adapter, E2E-verified
- **M1** — real sprint dry-run on actual tickets/repos; tune prompt template
- **M2** — adapter layer extracted; **aider+OpenRouter backend**; runner-owned
  push/PR step; config layer (global + sprint + .env + `tickets_repo`)
- **M2.5** — ingestion: `github` importer (easiest), tickets-repo clone/pull/
  push workflow, triage run type + `## Triage` section, `needs-info ⇄ ready`
  loop (CLI-first)
- **M3** — review pipeline: reviewer-run adapter + review.json schema
- **M4** — the full UI: 14-screen web app served by the conductor +
  desktop shell (Tauri) + OS packaging (signing, notarization,
  auto-update — a real milestone line item, not an afterthought): inbox,
  wizard, doc review, code review, KB, monitor, settings — the product
  is the app; the tickets-repo PR flow ships alongside as the secondary
  channel.
  **Validation gate: the engine must prove value on real tickets
  before the full UI investment — the pilot informs but does not block.**
- **M5** — post-PR shepherd: CI watch, PR-comment loop, rebase run,
  merge detection
- **M6** — productization: installer, docs, second backend adapters,
  hardening

## 12. Resolved design Q&A (2026-10-03 session)

1. BYOK = user's key into BYOK-capable agent harnesses (runner stays thin)
2. BYOK provider = **OpenRouter only** (v1); more later
3. OR harness = **aider**
4. Backend selection = **user configuration** (layered config + overrides)
5. Quality gate = **deep LLM review + GitLab-style review UI with notes**
6. Human notes **feed back to agent**, loop until approve → PR
7. Tickets = hand-written MDs *(superseded 2026-10-03: multi-source
   ingestion — Jira/GH Issues/Linear/manual — into a configured tickets
   repo, which becomes source of truth after import)*
8. Audience = **potential product/OSS**
9. Shell = ~~desktop app, JS/TS~~ **SUPERSEDED by item 34**
10. Boundary = **full lifecycle** (file → merge)
11. Artifact docs = **stage-gated**: PRD drafted after requirements Q&A →
    human-approved → technical Q&A → TDD drafted → human-approved →
    (test doc proposed) → implement
12. TDD drift = **proceed + flag** (deviation notes in pr-body + TDD
    addendum)
13. Parallelism = **full parallel w/ git worktrees** for same-repo impls
14. Backend/model (MVP) = **one global** (aider+OR or devin + model
    picker); per-stage routing deferred
15. Test doc = **confirmed**, same approval gate; coverage enforced by
    **mechanical matrix pre-check** pre-review
16. Test ordering = **alongside code** (no red-green ceremony)
17. Test done-contract = **human decides** — test-report on the code-review
    page, fix-or-approve; runner re-runs suite for ground truth
18. Deep review = **multi-pass specialists** merged into one review.json
19. Findings = ~~auto-fix all~~ **SUPERSEDED by item 23** →
    severity-gated fixing (§7.3)
20. `review_model` = **separate setting** (recommend different family)
21. Re-review = **full passes each round**
22. Clean review = **still human-approve**
23. Adversarial-review pass applied (2026-10-03): severity-gated fixes
    (not auto-fix-all); runner owns all env-touching steps + backend
    capability flags; LOG.md generated from events.jsonl; fail-closed
    gitleaks scan; gate modes (full/plan-package/minimal); CLI-first
    validation gate before Electron; added rebase/abort/timeout/
    change-detection/notifications/handoff/revert; cost+human_minutes
    in event schema
24. Schemas (2026-10-03): markdown tables w/ pinned columns; `repos:`
    list (cross-repo common → N worktrees, N linked PRs); fingerprint
    dedupe for review threads; medium-granularity events; fail-closed
    doc lint. All contracts in SCHEMAS.md
25. Settings (2026-10-03): YAML; secrets in .env; repo cards auto-probed
    + execute-verified; spec in SETTINGS.md
26. MVP (2026-10-03): CLI/engine-complete pipeline; review surface =
    tickets-repo PRs; BOTH backends v1; pilot informs tuning (no gate);
    Electron post-MVP; cutline in MVP.md
27. Prompts: locked/shipped, versioned with product; templates live in
    prompts/ (triage, design, testplan, implement, review-base+4 passes,
    fix, rebase)
28. Reframe (2026-10-03): product = **upstream attention** — specs
    rigorous enough to drive implementation; code is cheap, judgment
    isn't. Spec-depth tiers (light/standard/deep) = same deliverables,
    variable thoroughness, orthogonal to gates. Headline metric =
    **deviation rate**. External review fixes applied: missing stage
    prompts (prd/probe/import/ci-fix/escalate/discuss) written; case_id ↔
    test linkage convention; runner-computed fingerprints; untestable
    file-plan annotation; spend caps + shepherd cycle cap + dismissal
    cap; git-ref CAS extended to human-gate claims; sentinel =
    last-non-empty-line contract; fix dismissal rate limited; spec-
    compliance partly mechanical; human_minutes = gate-dwell.
29. Upstream expansion (2026-10-03): tickets mostly authored in-app →
    **interview mode** is the upstream entry point (same wizard as
    triage); splitting is constant → **auto-split run type** (children
    carry parent/depends_on, `split` terminal state for parents); spec
    format = structured where it pays (verifiable ACs); author ≈
    approver (gates = self-checkpoints, no role routing); roadmap adds
    spec linter + prior-art recall + DoD section + spec-bug feedback
    loop.
30. Knowledge base (2026-10-03): dossiers live in the **DB layer**
    (three-class split: approval/audit→git, coordination→DB,
    query/reference→DB — dossiers are regenerable, not audit docs);
    sources = everything (code/docs/screenshots/**Playwright crawl**/
    tickets/analytics); granularity = repo + product rollup; personas =
    agent-inferred→human-corrected; gaps = report-only; freshness =
    manual admin sync + scheduled re-survey (weekly default, cadence
    TBD); **full survey in MVP** incl. crawl; KB screen = S-14.
31. Semantic layer (2026-10-03): ontology-lite (entities + typed-edge
    relations, no RDF) + local embeddings (sqlite-vec/pgvector) +
    controlled taxonomies (deviation reason_kind, question gates) +
    entity linking (entities_referenced in triage.json). Survey
    extracts entities; triage links ticket terms → dossier. Local
    encoder default = free/private retrieval; remote providers later.
32. Engine hardening round (2026-10-03): **babysitter conductor**
    (persistent helper advances all non-gate transitions overnight —
    CONDUCTOR.md); auto-advance = everything EXCEPT implement (human
    "go" = spend checkpoint + cost estimate); DB schema written
    (DB-SCHEMA.md); adapter contract formalized incl. token table
    (ADAPTERS.md); dossier wait = depth-gated (light/standard flow
    degraded, deep parks); schema versioning = migrate-on-touch;
    doc-repair = agent docs auto-repair once then human, human docs
    straight to human; **sprint concept dropped** (context →
    products.<p>.context_file); **`permission_mode: smart` default**,
    bypass opt-in only.
33. **MVP = full product** (2026-10-03 correction): there is NO zero-UI
    mode — MVP ships all 14 screens + the babysitter conductor + the
    implement "go" checkpoint (UI button + cost estimate). github.com
    flows (doc-approval PRs, checklist Q&A) become secondary channels,
    not the product. Authored IDs = `SR-NNNN` workspace counter
    (`.sprint-runner/next-id`, CAS); collisions = warn-only; actor =
    explicit `actor:` config field.
34. Delivery architecture (2026-10-03): UI = **web app served by the
    conductor on localhost**; desktop = thin shell (Tauri preferred,
    Electron acceptable) for presence only — dock, notifications,
    badge, launch-on-login. Daemon serves the identical surface to any
    browser — no second frontend. The engine can never be cloud-only
    (local worktrees/processes); **cloud multi-tenant SaaS deferred** —
    different trust model. Security: bind `127.0.0.1` default, bearer-
    token always, wider bind requires explicit opt-in + auth.
35. Token accounting (2026-10-03): **formal requirement** — per-ticket
    in/out/cached tokens, `usage.json` per-call ledger artifact (SCHEMAS
    §13), `usage_calls` DB projection; input always exact (we render the
    prompt), output reported-or-estimated-and-flagged; `cost_usd` only
    where token-priced (null for devin — never synthesized); dual caps
    (`spend_cap_usd_per_ticket` + `tokens_cap_per_ticket`); live counter
    streamed where the adapter supports it.
36. TDD gap-closure round (2026-10-03 — cross-doc review vs PRD):
    **UI wire contract** written — API.md: REST + SSE, bearer token
    provisioned to `ui.token_file` (0600), `?token=` bootstrap
    loopback-only; **runner compute** split — inline mechanical checks
    vs detached `verify` tasks (a suite re-run never stalls the tick);
    **workspace column** on every ticket-keyed table + `subject`
    keying (survey/probe/import/interview runs have no ticket);
    `tickets` + `ticket_repos` projections — per-repo pr/ci state,
    `merged` = all repos merged; **sentinel→status transition table**
    in CONDUCTOR; new run types `doc-repair`/`revert`/`comment-fix`
    (prompts written); tail gating fixed — `approved` = open-PR gate,
    `ci-watch` = merge gate, never auto-merge; probe scheduling +
    card requirement scoped to repo-executing stages; interview
    `{{NEW_ID}}` reservation at run start; conductor-side split
    materialization (SCHEMAS §14); git-ref CAS lock expiry via
    `expires_at` ref content; `blocked_reason` frontmatter field;
    triage.json gains `entities_referenced`/`files_likely_touched`/
    `risk_summary`; `findings-<pass>.json` → runner-merged
    `review.json`; `usage_partial` = internal stream, never a ledger
    event; SETTINGS gains `actor`, `security:`, `escalation_model`,
    `shepherd.poll_interval_s`; timeouts completed for all run types;
    pause = SIGSTOP/SIGCONT; heartbeats conductor-observed; DoD
    `verified_by` = `cmd:`|`manual`.

## 13. Still-open research items

- Failure taxonomy: agent-failure vs env-failure vs unclear-ticket —
  `blocked_reason` exists; fold in aborted/killed/reverted states.
- Verify `devin -r <id> -p` composes non-interactively for resume/retry —
  otherwise rely on resume-aware fresh runs (branch state → continue plan).
- Escalated destination: v1 = a visible queue in the app any human can
  claim; tracker write-back later (the escalate prompt writes the
  hand-back into the ticket — the author isn't notified externally yet).
- Layered spec package (must/should/reference injection) is designed but
  not yet implemented in implement.md — add when weak-model runs show
  context starvation.
- Prompt-eval loop: no golden-ticket suite re-running shipped prompts
  against recorded sessions to catch regressions as models churn — the
  ledger is the substrate; the harness is future work.
- Naming: "sprint-runner" undersells the review/audit differentiator —
  revisit before any external release.
- Importer adapter interface detail (auth, pagination, field-mapping,
  re-import idempotency) — contract is one line today; Jira field
  mapping especially needs a real spec.
- Transcript-bloat policy (compress/prune artifacts in tickets repo at
  scale); GitHub webhooks as a daemon-mode upgrade over v1's
  `shepherd.poll_interval_s` polling.
- Naming/packaging/distribution channel.
