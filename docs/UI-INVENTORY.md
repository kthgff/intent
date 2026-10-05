# Screen & Workflow Inventory — Veto

Companion to `PRD.md` and `FEATURES.md`. Status: reconciled 2026-10-04.
This is the canonical inventory of product workflows, pages, and shared
surfaces.

Organizing principle: **capture ideas, turn them into governed work, and make
the next human or agent action unmistakable.** Home remains the daily operating
surface: a pipeline Board plus a needs-attention Inbox. Projects add the broader
idea-to-production layer: Boards → Initiatives → Features → Tickets. Ticket,
Feature, and Initiative pages use the same operational-hub pattern (Next action
+ workbench + Status/What's-left rail). Heavy evidence surfaces remain
dedicated routes. Contextual AI appears only where an object is being edited.

**Delivery:** one web app, served by the conductor on localhost — the
desktop shell is a thin wrapper (Tauri preferred) for native presence;
daemon mode serves the identical surface to any browser. No second
frontend, no Electron-only assumptions inside the screens.

---

## 1. Workflow inventory

### WF-01 — First-run onboarding
Welcome → pick backend (devin CLI / aider+OpenRouter) → provide key(s) →
create/connect a project → add code repos (name + path + repo card probe) →
pick `main_model` + `review_model` → pick `gates` mode → done. First run
creates a seeded Getting Started board. Screens: S-02, S-13, S-15.

### WF-02 — Create or import tickets
Two entry points: **Interview mode** (type a rough idea → AI interview
through the wizard → well-formed ticket document version) OR **Import**
(source: github milestone / jira JQL / csv → auth → preview+edit table
→ import → immutable initial version). Both land at `imported` → spec lint → triage.
Screens: S-03 (Create/Import), S-04 (interview = same wizard).

### WF-03 — Triage a ticket (needs-info loop)
Inbox item "questions on ABC-123" → Q&A wizard (one at a time, options +
recommended + mic + skip=accept) → "accept all" or answer → save version →
re-triage → repeat or ready/escalated. Bail-outs: force-ready, wont-do.
Screens: S-04 (wizard), S-05 (ticket detail context).

### WF-04 — Review & approve a doc (×3: PRD, TDD, test plan)
Inbox item "PRD ready" → doc review page (rendered markdown, comment
threads on paragraphs, diff vs prior version, coverage matrix for
test.md) → leave feedback (→ agent revises, new version) or approve →
next stage. `plan-package` mode: all three docs in one page, one approve.
Screens: S-06.

### WF-05 — Monitor implementation
Ticket detail → live run monitor: transcript stream, current TDD step,
elapsed / live in+out token counter / cost (where computable), commit
feed — plus **kill** (abort, preserve worktree), **pause**, **hand off
to human**.
Screens: S-07, S-05.

### WF-06 — Review code & merge
Inbox "review ready" → code review page: header brief (diffstat, AC
traceability, spec compliance, TDD addenda, risk register, tech-debt,
highlights, commit story) → Changes tab (diff + inline comments) →
Issues tab (LLM threads, accept/dismiss, batch-fix) → test panel
(ground-truth results) → **approve → merge** (strategy from settings) or
**send back to fix**.
Screens: S-08.

### WF-07 — Shepherd a PR (post-approve)
PR panel: CI checks live, teammate comments → auto-fed to agent → new
commits → re-check → green → merge button → merged (status, SHA logged).
Failure: revert button → `reverted`.
Screens: S-09.

### WF-08 — Handle failure / blocked
Inbox "ABC-123 failed" → failure detail (stage, reason, log tail, env
vs agent classification) → actions: retry (optionally stronger model),
edit ticket + retry, escalate, wont-do, kill stuck run.
Screens: S-10, S-05.

### WF-09 — Handle an escalation
Escalated queue → ticket shows unresolved questions + findings → claim:
answer inline (→ back into loop), forward to author (external), wont-do.
Screens: S-10 (queue), S-05.

### WF-10 — Audit / inspect the ledger
Ticket detail → Activity tab: append-only event timeline and generated log,
per-run artifacts (prompts, transcripts, usage, review results,
reports) + per-ticket token rollup (in/out/cached by stage, cost where
computable, estimated flags). Replay any stage. Screens: S-05
(Activity), S-11.

### WF-11 — Take over a ticket / human handoff
From run monitor or ticket detail → "hand to human" → worktree+branch
preserved, handoff summary appended to ticket → human works locally →
"resume pipeline" returns it (re-enters at review).
Screens: S-05, S-07.

### WF-12 — Daily loop (the actual day-to-day)
Open app → **Board**: see where every ticket sits, failed ones flagged
in-phase → flip to Inbox tab (or click attention badges) → clear:
questions pending, docs to approve, reviews waiting, failures,
escalations. The focus page clears most gates. This
loop IS the product's daily surface.
Screens: S-01 (home), everything downstream.

### WF-13 — Settings & maintenance
Add/edit code repo (+repo card re-probe), rotate keys, switch backend,
change models, gate mode, timeouts, merge strategy, worktree root,
notifications, project add/remove, board/capture settings, synthesis limits,
verification command/app URL, and survey cadence.
Screens: S-02.

### WF-14 — Metrics / ROI check
Dashboard: tickets→merge rate, per-model success, cost-per-merge,
tokens-in/out per ticket + per stage (split out alongside $ — honest
across non-token-priced backends), human-minutes/ticket, fix-round
distribution, gate where tickets die — plus spec-quality panel:
deviation rate (headline), spec-score trend, spec-bug vs code-bug
finding mix. Screens: S-12.

### WF-15 — Approve a split plan
Inbox "split proposed on ABC-123" → split-plan view (child table:
titles, repos, depends_on, AC coverage map vs parent) → edit boundaries
→ approve (children land `imported`, parent → `split`) or reject
(back to author flow). Screens: S-06 variant, S-05 (family rail).

### WF-16 — Survey a product / refresh the knowledge base
Add code repo → repo-card probe + survey run queued (watchable in
S-07) → dossier lands in DB → KB screen shows sections + gap report.
Re-sync anytime via admin **Sync** button or scheduled refresh
(cron). Screens: S-14, S-02 (admin).

### WF-17 — Review & correct the dossier
KB screen → browse dossier sections (architecture, workflows, personas,
gaps) → correct wrong facts inline (agent proposes, human disposes —
edits are DB writes + ledger events) → confirm inferred personas.
Screens: S-14.

### WF-18 — Capture on an idea board
Project boards (named, Postgres) → drop typed stickies (thought/goal/
ambition/question/requirement/reference), text, docs, images, files,
links, voice notes; zones/frames group; comments discuss. Agents add
items too (survey gaps, findings — `source:` chip). Icebox parks.
Screens: S-15, S-16.

### WF-19 — Synthesize a board into an initiative
"Synthesize" on a board → scoped extract run (`board | zone |
selection | new-since-last-run | tray` — dossier digest + prior-art
overlap included) → S-04 Q&A wizard (≤15 questions; overflow → PRD
`Open questions`) → initiative `prd.md` draft + provenance.json →
doc review → initiative lives. Consumed items freeze+dim;
`discarded` releases them; ship → they light up `shipped` on
`released` (§WF-22). Screens: S-16, S-04, S-06, S-18.

### WF-20 — Decompose initiative → features → tickets
Initiative decompose run → split-plan of features (AC coverage map)
→ approve → feature test-plans reviewed (batch-able, plan-package
default) → feature decompose → ticket split-plan → approve → tickets
`imported` w/ `feature:` → normal pipeline. Kanban delivery view on
the board tracks it all (full card actions). Re-plan re-runs
decompose on unmet ACs (split-plan v2 diff); re-parent moves work;
manual initiative/feature creation supported without a board.
Screens: S-16, S-17, S-18, S-06, S-05.

### WF-21 — Capture anything, anywhere
CLI `veto add`, `⌘⇧C` quick-capture, `POST /capture` (webhook/
email), mobile `/capture` route, or the S-16 tray dock → items land
in the project tray (`board: null`) → drag onto a canvas or sweep up
in a tray-scoped synthesis. `feedback` items capture production
signal onto shipped work. Screens: S-19, S-20, S-16 (tray dock), S-15.

### WF-22 — Verify & release
Ticket(s) merge → `verifying` → `verify_cmd` run or `app_url` smoke
(survey crawler) → `released`; no automated check → `verify-confirm`
gate (one-click). `verify_failed` → S-10. `gates.uat` requires the
human gate even after green smoke. Board item → `shipped` only on
`released`; initiative `delivered` → release-notes run + retro card.
Screens: S-05 (verify state), S-01, S-10, S-18.

### WF-23 — Search and navigate across the product
`⌘K` or the global search field → search projects, boards/items,
initiatives, features, tickets, document contents, runs, and dossier
entities → results grouped by type with status/parent context → open the
canonical page. The same palette exposes Create, Capture, switch-project,
retry, and open-current-run commands. Screens: global Command/Search overlay,
then S-05/S-11/S-14–S-20.

---

## 2. Screen inventory

Routes use the user-facing `:project` name below; existing APIs may continue to
call that key `workspace` until the internal migration.

| ID | Route | Screen and job | Required page functionality |
| --- | --- | --- | --- |
| **S-01** | `/` | **Home — Board + Inbox.** Understand where all work stands and clear the highest-value human actions. | Board tab: Backlog/Spec/Build/Review/Done, live counts/WIP, project/filter scope, attention-first cards, agent-run progress, Ops gates, empty/stale/error states, validated drag/drop, card→hub. Inbox tab: grouped gates across tickets/features/initiatives/boards, claim, snooze, batch approval, owner/my-moves filter, ranking failure/escalation→priority→age. |
| **S-02** | `/settings` | **Settings and onboarding.** Configure the local engine and every project. | First-run checklist; General; Projects; Code repos + probe/re-probe; Backends & keys; Models; Gates & budgets; Merge; Notifications; Worktrees; Boards & synthesis (`max_questions`, context budget, digest, agent-items mode); Verification (`verify_cmd`, `app_url`, UAT); Survey cadence; Evidence/code intelligence (index, freshness, context budget, evaluation); deferred telemetry sources/redaction/retention; Security; Advanced; validation, unsaved/risky changes, save/test controls. |
| **S-03** | `/new` | **Create / Import.** Start structured work directly without requiring a board. | Create Ticket/Initiative/Feature selector; parent/project picker; rough-idea interview or paste existing Markdown; template/depth/priority/owner; Import tabs for GitHub/Jira/CSV with authentication, filters, mapping, preview/edit/select, duplicate/re-import warnings, repo assignment, validation, and creation results. |
| **S-04** | `/questions/:session` (plus subject deep links) | **Shared Q&A wizard.** Resolve any agent→human questions. | Subject/breadcrumb and cited source context; one question at a time; yes/no/single/multi/text; recommended choice and why; Other; voice; skip=default; accept-all; progress/round/question caps; prior answers; claim/snooze; force-ready/wont-do/escalate exits; completion/re-triage state. |
| **S-05** | `/tickets/:project/:ref` | **Ticket Focus operational hub.** Know the next action, complete it, and work one ticket through release. | Header status; inline Next action for question/approval/implementation/review/failure/verify/completion; Overview; Documentation with immutable versions/history/diffs and contextual AI; evidence/traceability summary with current/stale badges and source navigation; full Code review spotlight; Activity ledger; Runs; failure/split/verify variants; branch/repos/family/dependencies; Status + What's-left roadmap; move/re-parent/handoff/wont-do where valid. |
| **S-06** | `/subjects/:ref/docs/:doc` | **Document / plan review.** Review any ticket, feature, or initiative document and split plan. | Rendered Markdown/editor; current and prior versions; side-by-side/unified diff; paragraph threads; contextual AI revision; approve/request changes; PRD/TDD/test coverage views; cited PRD-quality findings; DoD; trust-inheritance delta; grounded-in-items/provenance and intent→code/test links with verify/reject; source peek pinned to commit/doc version; plan-package/batch approval; split-plan table, AC coverage, boundary edits, v2 re-plan diff. |
| **S-07** | `/runs/:id` | **Live run monitor.** Understand and safely control an agent run. | Subject/stage/model/backend; current plan step; live transcript/search/follow; elapsed/heartbeat; exact/estimated token and cost stream; commit/event feed; artifacts; health/stall/error state; pause/resume, kill, retry, stronger-model retry, handoff, open worktree/subject. |
| **S-08** | `/tickets/:project/:ref/review` | **Code review.** Validate agent-authored code against the approved spec. | Review brief; diffstat; AC traceability; verified-vs-suggested code/test links; evidence freshness; TDD file-plan compliance/addenda/deviations; risk/tech-debt/highlights/commit story; file tree and unified/side-by-side diff; inline threads; specialist findings with severity/evidence/confidence/fingerprint; dismiss/wontfix/send-to-fix/batch-fix; ground-truth test report; re-review rounds; approve/open PR or request changes. |
| **S-09** | `/tickets/:project/:ref/pr` | **PR shepherd.** Move approved multi-repo changes through CI and merge. | Per-repo PR rows; commits; checks; teammate reviews/comments; auto-fed fix/rebase runs and cycle caps; merge readiness/DoD attestations; pause agent; open provider; merge strategy/button; partial multi-repo state; revert; stale/conflict/error states. |
| **S-10** | `/queue` | **Escalations and failures.** Recover everything broken, blocked, returned, or stale. | Filters for failed/blocked/escalated/aborted/doc-repair/verify_failed/stalled; project/entity/stage/severity/owner filters; ranked rows; detail inspector with classification, evidence and log tail; claim/snooze; retry/stronger-model/edit+retry/fix environment/kill/forward/wont-do; open run or operational hub. |
| **S-11** | `/ledger` (embedded in hubs) | **Ledger and artifact browser.** Audit every decision and machine action. | Global/project/subject/run scope; event timeline/search/filter; actor/stage/type/cost/token fields; structured payload; artifact tree with prompt/transcript/usage/review/test outputs; immutable doc-version history and comparison; replay eligible stages; generated human-readable log; export/deep link. |
| **S-12** | `/metrics` | **Metrics / ROI.** Measure throughput, quality, cost, and the idea-to-release loop. | Date/project/model/stage filters; tickets→release funnel; success/failure; tokens/cost/human gate dwell; fix rounds; deviation/spec-score/spec-bug trends; ACs with verified test evidence; pre-implementation spec defects; rework/escaped defects where connected; idea→merge and idea→released lead time; cost per feature/initiative/goal (D33 serves rollups); board yield; retrieval/citation evaluation health; stale ideas; cohort/drill-down tables; honest unavailable/estimated labels; no individual developer ranking. |
| **S-13** | `/projects` | **Project switcher and project management.** Enter or maintain a product/codebase context. | Project cards with health, repos, dossier/survey freshness, boards, initiatives/features/tickets, open gates/runs, owners; switch/pin/search; add/import project; connect repos/docs/app URL; sync; archive/remove with impact confirmation; empty/onboarding states. (`/workspaces` is the temporary implementation route.) |
| **S-14** | `/kb` | **Knowledge and evidence.** Inspect and correct the intelligence feeding every run. | Project/repo tree; Dossier tab (architecture/domain/workflows/personas/UI map/docs/glossary/landmines); Code tab (index head/status, symbol/path/exact/semantic search, structural neighbors, source pinned to commit); Traceability tab (verified/suggested edges, provenance/confidence, verify/reject); source/freshness evidence; gap report with severity/disposition and create-board-item action; inline human correction with history/ledger attribution; confirm aliases/personas; survey/index status, manual Sync/Reindex, scheduled refresh, source management. Phase C adds sanitized signatures/incidents here and routes operational failures/proposed tickets through S-10/S-03 rather than creating a new top-level page. |
| **S-15** | `/boards` | **Boards list.** Pick, create, organize, and assess idea boards in a project. | Board cards with open/consumed/shipped/parked/stale counts, tray count, last synthesis/initiative, saved delivery filter, digest gate, owner/activity; search/sort; templates (blank/PRD prep/retro/research); create/rename/duplicate/archive; seeded Getting Started board; quick capture entry. |
| **S-16** | `/boards/:id` | **Board canvas + Delivery view.** Capture raw intent, synthesize it, and track spawned work. | Idea mode: autosaved pan/zoom canvas, typed/color stickies (incl. `goal` chip — live progress badge, `active/achieved/abandoned` states, D33), text/docs/images/files/links/voice, zones, connectors (`serves` edge writes on drop/drag), comments/tags, source chips, inspector (incl. serves picker), undo/redo, icebox, tray dock, uploads/ingest. Synthesis: board/zone/selection/new/tray scope (goal-required — inline ask if absent), count/cost/context preview, run/Q&A handoff. Item states open/consumed/shipped/parked/superseded with produced links. Delivery mode: shared S-01 Kanban filtered to board provenance, full card/gate actions, configurable filter (incl. `goal`). |
| **S-17** | `/features/:ref` | **Feature Focus operational hub.** Govern one delivery unit and its tickets. | Breadcrumb to initiative/board/project; served-goal chips (inherited `serves` chain, D33); Next action; Overview with feature goal and inherited context; Documentation (`feature.md`, `test.md`, versions/diffs/contextual AI); AC slice and coverage/provenance; Tickets rollup and attach/create/decompose; dependencies/blockers; Activity/Runs; test/split/verify states; Status/What's-left rail; priority/owner; re-plan, move/re-parent, cancel cascade. |
| **S-18** | `/initiatives/:ref` | **Initiative Focus operational hub.** Govern the spec container created from ideas. | Breadcrumb/board/items grounded; served-goal chips + goal one-liner (D33); Next action; Overview/PRD summary/metrics; Documentation (`prd.md`, `tdd.md`, trust delta, contextual AI); Features rollup with tickets/gates/cost; two-pane AC↔board-item provenance viewer/editor with amendment history; Activity/Runs; Status/What's-left; priority/owner/dependencies; re-plan/move/discard/unconsume/cancel cascade; verify/release notes/retro/feedback. |
| **S-19** | `/capture` | **Quick Capture.** Record an idea or production signal with near-zero friction. | Mobile/desktop minimal form; text/voice/file/link/image input; auto-guessed type with one-tap correction; project; board-or-Tray destination; optional related initiative/feature/ticket; feedback mode; saving/saved/offline/error/retry; add another/open destination. Uses the same component as the global `⌘⇧C` modal without loading the canvas runtime. |
| **S-20** | `/tray` | **Project Tray.** Triage, route, or synthesize captured items that do not yet belong to a board. | Project-scoped search/filter/type/source/age/stale/ingest-state; list/grid and item preview/inspector; edit/supersede; attachment extraction/transcription status and retry; select/bulk move to board/zone/icebox; drag to board; create board from selection; link feedback to subject; synthesize selected/whole tray with context + cost preview; empty/conflict/error states. |

## 3. Global surfaces and overlays

| Surface | Available from | Functionality |
| --- | --- | --- |
| **Application shell** | All desktop pages | Primary navigation, current Project scope, global search, create/capture, notification count, connection/live state, user/actor, keyboard shortcuts, responsive collapse. |
| **Command + Search palette** | `⌘K`, header search | Search projects, boards/items, initiatives, features, tickets, docs, runs, and KB entities; grouped results with parent/status; recent items; commands for create, capture, switch project, open run, retry, and settings. |
| **Quick Capture modal** | `⌘⇧C`, `⌘K capture`, global `+` | Compact S-19: idea/feedback input, auto type, project, board-or-tray destination, optional related subject, voice/file/link support, immediate saved confirmation. |
| **Global Create menu** | Global `+`, project/board headers | New Board, Initiative, Feature, Ticket; chooses parent/project then routes through S-03/S-04 or directly to the new object. |
| **Notifications / attention popover** | Bell, desktop notification | Recent gate/failure/run/release events, mark read, snooze, open subject, notification preferences; Inbox remains the durable complete queue. |
| **Confirm / conflict / stale modals** | Destructive or state-changing actions | Explicit impact for discard, cancel cascade, re-parent, archive, kill, wont-do, merge, revert, unconsume; stale-version/claim conflicts resolve without silent overwrite. |
| **Toasts and background task center** | All pages | Saved/queued/completed/failed feedback with links to run/subject; reconnect and stale-data warnings; never the only record of an outcome. |

## 4. Shared components (build once, use everywhere)

| Component | Used by |
| --- | --- |
| **Q&A wizard** (S-04) | interview mode, triage Q&A, design Q&A, test-plan Q&A, fix-triage |
| **Doc reviewer** (S-06) | PRD, TDD, test.md — any markdown approval |
| **Comment thread** (anchored) | doc paragraphs, diff lines, issue cards, PR comments |
| **Status + remaining-work roadmap** | S-05 rail, queue chips, inbox items |
| **Run monitor** (S-07) | triage, design, implement, review, fix, rebase, revert, survey, interview runs |
| **Ledger view** (S-11) | ticket Activity tab, audits, prior-art lookup |
| **Dossier viewer/editor** (S-14) | KB browsing, human corrections, gap report |
| **Versioned Markdown viewer/editor** | ticket, feature, initiative docs and project context |
| **Operational hub shell** | S-05 Ticket, S-17 Feature, S-18 Initiative |
| **Pipeline Kanban** | S-01 project-wide Board, S-16 Delivery view |
| **Entity rollup table** | S-17 child tickets, S-18 child features, split/re-plan reviews |
| **Provenance viewer/editor** | S-06 grounded docs, S-18 initiative provenance |
| **Capture/item inspector** | S-16 canvas, S-20 tray |

## 5. Screens per status (state machine → UI map)

| Status | Where it surfaces | Human action |
| --- | --- | --- |
| imported | queue | none (auto-triages) |
| triage | — (auto run, watchable in S-07) | none |
| needs-info | inbox + S-04 wizard | answer / accept-all / bail |
| escalated | S-10 queue | claim / forward / wont-do |
| prd/tdd/test-draft→review | inbox + S-06 | comment / approve |
| ready | queue (auto-advances) | none (or forced override) |
| in-progress | S-07 monitor | watch / kill / handoff |
| review (auto-fix rounds) | S-07 (fix runs) | none until cap |
| changes-requested | inbox + S-08 | triage threads / fix |
| approved | inbox + S-08 | open PR (push + create, all repos) |
| pr-open / ci-watch | S-09 | shepherd / merge / revert |
| failed / blocked | S-10 | retry / fix env / wont-do |
| merged / verifying | S-01 Review + S-05/S-17/S-18 | watch smoke/verify run or confirm live |
| verify_failed | S-10 + subject hub | inspect evidence / retry / confirm failed / revert |
| released | S-01 Done + subject hub + S-18 rollup | inspect release notes / add feedback |
| reverted / wont-do / aborted | ledger (S-11) + subject hub | recover/re-plan when permitted |
| initiative/feature split-plan | inbox + S-06 + S-17/S-18 | edit boundaries / approve / reject |
| board-digest | inbox + S-15/S-16 | synthesize / move to icebox / keep |
| initiative delivered/closed/discarded | S-18 + S-16 | release notes / retro / release consumed items |

## 6. Decisions (Q&A 2026-10-03 through 2026-10-04)

- **Multi-user**: multiple installs can use the same Postgres-backed projects
  and shared queue. Everything carries event `actor` attribution; gated items
  get DB-backed claims/leases so two humans do not answer the same wizard.
  Optional owner fields route work without replacing claims.
- **Engine model**: **detached runs + persistent babysitter** — agent
  runs execute as detached OS processes or `docker exec` sessions in a
  per-ticket container (D30: `runtime: container` backends, aider in
  v1 — one persistent container per subject, stopped at gates, removed
  on terminal); a lightweight conductor process
  (CONDUCTOR.md) watches them, collects artifacts on exit, lints,
  writes status/events, and auto-advances all non-gate transitions EXCEPT
  implement (human "go" = the spend checkpoint). Pipeline moves
  overnight; the app is a UI on an already-running conductor. Headless
  `veto daemon` = same engine, no UI, for team 24/7.
- **Inbox**: unified across all projects and subject types (filterable). **Home is
  now the Board** (D21): 5 phase columns (Backlog·Spec·Build·Review·
  Done) collapsing the status enum; failed/blocked stay in-phase
  flagged; attention = badges on cards (in-column sort attention-
  first→priority→age); Done capped ~20 + "show more"; non-ticket
  gate items live in an ops strip above the columns; board snooze
  hides the card. Inbox survives as Home tab 2.
- **Board** (2026-10-03, D21): unified, filterable; cards = id/title/
  priority/sub-status + attention badges; drag-drop allowed for
  **human-meaningful transitions only** (wont-do, retry, claim — server
  validates via `drop_targets`, forward pipeline moves always
  rejected); KPI strip = per-column counts + WIP only (deep metrics
  stay on S-12); card → **full-page ticket focus** (`/tickets/<ref>`):
  inline Next action + workbench + narrow Status/What's-left rail;
  monitor/review/ledger are linked or embedded routes (drawer design
  rejected for space, 2026-10-03; layout superseded by D25).
- **Chat-to-edit** (2026-10-04, D25): contextual AI edits the current
  object — ticket.md, a selected PRD/TDD/test document, or a selected
  code-review finding/comment — never cross-ticket. It is absent from
  general page chrome and non-editing tabs. Reuses the interview run
  machinery (`POST /interview` + `subject_ref` + `target` per SCHEMAS
  §16). No new run kind.
- **Focus page replaces S-05** (2026-10-04, D25): the card-click
  destination IS the ticket page. IA: inline Next action (current move
  only) · wide workbench tabs Overview/Documentation/Activity/Runs +
  status-conditional spotlight tab (full S-08 embedded in review,
  Failure detail, Split plan) · narrow Status/What's-left rail. **Doc
  versioning**: every persisted change to PRD/TDD/test = a version
  (agent + human/chat edits alike); version history + GitLab-MR-style
  before/after diffs between any two versions; Activity tab = full
  S-11 ledger embedded.
- **Inbox ranking**: **human-anxiety-first** — failures/escalations rank
  above routine agent Q&A/approvals; within a class, ticket priority
  then age. (2026-10-03, D21 — supersedes blocking-first: a broken
  thing outranks an idle agent. Applies to inbox list and card badge
  emphasis.)
- **Entity expansion** (2026-10-04, FEATURES.md): **project** =
  merged workspace+product (`workspace` stays the internal key);
  **initiative** owns prd.md+tdd.md (born of a board synthesis);
  **feature** = parent-with-docs unifying split families; tickets may
  be feature-scoped or project-scoped orphans. **DB-only storage**
  (tickets repo dropped — Postgres + append-only events + immutable
  doc versions). Screens S-15–S-17 added.
- **Loop-closing** (2026-10-04, D27, WORKFLOW-REVIEW + GAP-SOLUTIONS):
  **verify stage** `merged→verifying→released` (+`verify_failed`,
  `verify-confirm` gate, `gates.uat`); board item `shipped` requires
  `released`; **S-18 initiative detail** added; **unconsume** via
  `discarded` initiatives; **scoped synthesis** (zone/selection/
  new-since-last-run/tray); **capture tray** (`board: null` items,
  `POST /capture`, CLI `veto add`, `⌘⇧C`); **provenance amendments**
  (editable link map, append-only events); **re-plan** decompose +
  re-parent; `synthesize.max_questions: 15`; dossier + prior-art in
  extract; owner/priority on initiative/feature; release notes on
  `delivered`; retro on `closed` too; feedback item type; no
  sprints/dates ratified as an omission.
- **Snooze** (2026-10-03, design docs): S-01 items can be snoozed
  (defer without clearing) — needs `gate_items.snoozed_until` column
  + `/inbox` field; snoozed items are excluded from badge counts.
- **Theming** (2026-10-04, D34): light + dark modes ship together —
  11 semantic tokens (`--bg`/`--bg-raised`/`--bg-hover`/`--border`/
  `--text`/`--text-dim`/`--accent`/`--green`/`--yellow`/`--red`/
  `--purple`), GitHub-dark + GitHub-light palettes; `ui.theme:
  system|dark|light`, `system` default follows `prefers-color-scheme`.
  Screens never hardcode color. Full spec + palette table:
  `docs/design/theming.md`.
- **Wire contract** (2026-10-03): the UI talks to the conductor via
  REST + SSE (API.md) — bearer token on every request, `?token=`
  bootstrap on loopback only. Run control = SIGSTOP pause / SIGCONT
  resume / SIGTERM→SIGKILL kill for process runs; `docker pause` /
  `unpause` / `kill` for container runs (D30). Screens read DB projections
  (`tickets`, `ticket_repos`, `gate_items`) — no direct file/git
  access in the frontend.

## 7. Completeness cross-check

| Product capability | Primary surfaces | Covered? |
| --- | --- | --- |
| Onboard/configure a Project and repos | S-02, S-13 | Yes |
| Capture an idea/feedback instantly | S-19, global Capture modal | Yes |
| Triage, route, and synthesize unassigned captures | S-20, S-16 tray dock | Yes |
| Organize ideas visually and park them | S-15, S-16 | Yes |
| Synthesize scoped ideas with cost/context preview | S-16 → S-04 → S-06 | Yes |
| Govern initiative specs, provenance, features, re-plan/discard | S-18, S-06 | Yes |
| Govern feature specs, AC coverage, dependencies, child tickets | S-17, S-06 | Yes |
| Create/import/directly author structured work | S-03, S-04 | Yes |
| Operate a ticket from question through release | S-05 | Yes |
| Review immutable documents and plans | S-06 | Yes |
| Monitor/control every agent run | S-07 | Yes |
| Review code and tests against the spec | S-08 | Yes |
| Shepherd multi-repo PRs and merge/revert | S-09 | Yes |
| Verify production and recover failures | S-05/S-17/S-18, S-10 | Yes |
| Route all human attention across entity types | S-01, S-10 | Yes |
| Audit events, artifacts, versions, cost, and actors | S-11 | Yes |
| Measure ticket and idea-to-release outcomes | S-12 | Yes |
| Inspect/correct product intelligence and gaps | S-14 | Yes |
| Inspect code evidence, citations, freshness, and traceability | S-14, S-05/S-06/S-08 | Yes (D37 Phase A) |
| Review alignment/release-risk findings without overriding hard gates | S-05/S-08/S-09/S-14 | Phase B |
| Investigate sanitized production incidents and approve ticket proposals | S-10/S-14 → S-03 | Phase C |
| Search/navigate/create from anywhere | Command/Search + Create overlays | Yes |
| Notifications, conflicts, and destructive confirmations | Global overlays | Yes |

No additional top-level page is required for Notifications, Search, Create,
or the global Capture shortcut; they are shared overlays with durable
destinations in S-01, S-03, S-11, S-19, and S-20. Verification is a lifecycle state
inside the operational hubs and failure queue, not a standalone page.
