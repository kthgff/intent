# CONDUCTOR — the sprint-runner engine spec

Companion to `PRD.md`. Draft 2026-10-03.
The conductor is the control loop that moves tickets through the state
machine. One per install (embedded in the app; `sprint-runner daemon` =
the same loop headless). It is a **watcher + scheduler, not a worker** —
stage runs execute as detached OS processes.

## Processes

- **Conductor** (persistent helper process — "the babysitter"): starts
  with the app/login item, watches the run registry, schedules stage
  runs, owns transitions, reconciles continuously. The pipeline moves
  overnight; gates wait for humans by definition.
- **Runs** (detached): one OS process per stage-run. Writes artifacts
  per `{{ARTIFACT_TARGETS}}`, exits with a last-line sentinel.
- **Runner tasks** (conductor-side compute — split by cost): cheap
  mechanical checks run INLINE in the tick (spec-lint scoring,
  coverage/doc lint, fingerprints, file-plan-vs-diff check, LOG.md
  regeneration, gitleaks, projection updates); heavy executions —
  repo-card suite re-runs for pre-flight and `test-report.json` —
  are DETACHED `verify` tasks: registered in `runs` like stage runs,
  own timeout (`timeouts.verify`), no agent involved. A 20-minute
  suite never stalls a 10s tick.
- **UI surface** (HTTP on localhost): the conductor serves the web UI
  itself — the desktop shell is a bundled webview pointed at it, and a
  headless daemon serves the identical UI to any browser. Wire
  contract = **REST + SSE**, specified in `API.md`. **Security:**
  bound to `127.0.0.1` by default (agents execute arbitrary code by
  design — an unauthenticated localhost surface is a CSRF→RCE door);
  bearer-token auth always (provisioned via `ui.token_file` — API.md);
  binding wider (LAN/tunnel remote access) requires explicit
  `ui.remote_access` + token on every request, warned in config.

## The loop (fires every ~10s tick + on run-exit + on tickets-repo pull)

1. **RECONCILE**
   - `git pull --rebase` the tickets repo (pull-rebase-retry); refresh
     the `tickets`/`ticket_repos` projections from frontmatter.
   - For each live run: process exited → collect artifacts → parse
     LAST non-empty line sentinel → extract usage → write
     `runs/<id>/usage.json` → validate structured outputs (fail-closed
     lint) → **sanitizer scan** (`security.scanner` — fail-closed; a
     scan error or finding blocks the commit and surfaces a `repair`
     gate item) → commit status + artifacts + events → release lease
     → check auto-advance.
   - Heartbeats are **conductor-observed**: each tick records pid
     liveness + artifact/log mtime into `runs.heartbeat_at` — the
     detached process never touches the DB. Dead → `stalled` warn;
     timeout exceeded → kill, preserve worktree, `run_killed` event,
     status stays for retry.
   - New `gate_items` row OR `run_failed`/`run_killed`/`blocked` →
     `notifications` row → SSE + desktop/badge per settings.
2. **CLAIM**
   - Next runnable unit = status allows a non-gate transition AND lease
     free AND all `depends_on` merged AND neither spend nor token cap
     exceeded.
   - **Repo-card rule (scoped)**: `verified: true` is required only for
     stages that execute inside a repo — implement, fix, ci-fix,
     comment-fix, rebase, revert, verify. Triage/design/testplan run
     cardless. A missing or unverified card on a ticket's repo → the
     conductor queues a `probe` run itself (subject `probe:<repo>`);
     triage never deadlocks waiting for a card only a probe can
     produce.
   - Order: ticket priority → oldest-first.
   - Acquire lease (DB or git-ref CAS); contested → skip this tick.
3. **LAUNCH**
   - Repo-executing stages (implement, fix, ci-fix, comment-fix,
     rebase, revert): create worktree(s) `<repo>.worktrees/<id>` +
     branch(es) — one `ticket_repos` row per repo in `repos:`.
   - Interview: reserve a fresh `SR-NNNN` via `next-id` CAS at run
     start and inject `{{NEW_ID}}` (a `WONT-DRAFT` just burns the
     number — ids needn't be contiguous).
   - Render prompt (token table per prompt file), inject
     `{{ARTIFACT_TARGETS}}` per backend `can_write_outside_tree`.
   - Spawn detached, register run row (`subject` = ticket id, or
     `survey:<scope>:<name>` / `probe:<repo>` / `import:<source>` /
     `interview:<run>` for non-ticket runs) + heartbeat.

## Auto-advance rules

- **Every non-gate transition auto-fires EXCEPT → `in-progress`** —
  the implement run needs a human "go" in the app (the spend
  checkpoint, shown with a cost estimate). MVP ships the UI, so the
  checkpoint ships in MVP.
- **Gates** (surface a `gate_items` row; wait for a human forever —
  the babysitter never bypasses a gate): `needs-info`, `design-qa`,
  `prd-review`, `tdd-review`, `test-review`, `test-approved` (the
  spend checkpoint), `changes-requested`, `split-plan`, `escalated`,
  `approved`, `ci-watch` — plus `repair` items that can land on any
  status.
- **Tail gating, stated once**: `approved` is the open-PR gate — the
  human's "approve & open PR" action fires push + `gh pr create` per
  repo; `pr-open` is transient (→ `ci-watch` when checks register).
  `ci-watch` is the merge gate — checks green → merge button enabled;
  merge NEVER auto-fires in v1.
- Auto chains: `imported → spec-lint → triage → needs-info`; triage
  `ESCALATE: needs split` → `split` run → `split-plan` gate;
  answers-committed → re-triage → `ready → prd-draft → prd-review`;
  `tdd-approved → test-draft → test-review`; `test-approved →`
  (waits for human go) `→ in-progress → review` (auto-fix rounds
  inside the cap) `→ changes-requested` gate.

## Sentinel → transition table

The core mapping — every sentinel a prompt can emit, and what the
conductor does. Missing/unparseable sentinel → `run_failed`.

| Run | Sentinel | Conductor action |
| --- | --- | --- |
| interview | `INTERVIEW-QA: <n>` | `question` gate item on the interview subject; re-run on answers |
| | `TICKET-AUTHORED: <id>` | commit `tickets/<id>/` → `imported` |
| | `WONT-DRAFT: <r>` | burn the reserved id, notify |
| import | `IMPORTED: <n>` | commit ticket folders, each → `imported` |
| | `IMPORT-FAILED: <r>` | `failure` inbox item |
| probe | `CARD-WRITTEN` | persist card (`verified` per probe's own report) |
| | `PROBE-FAILED: <r>` | card `verified: false` + inbox item |
| triage | `READY` | apply `suggestions` to frontmatter (human wizard edits win) → `ready` → auto `prd-draft` |
| | `NEEDS-INFO: <n>` | → `needs-info` + `question` gate |
| | `ESCALATE: needs split` | queue `split` run |
| | `ESCALATE: <other>` | → `escalated` |
| split | `SPLIT-PROPOSED: <n>` | commit `split-plan.md` + `children/` drafts → `split-plan` gate |
| | `UNSPLITTABLE: <r>` | → `escalated` |
| prd | `PRD-WRITTEN` | → `prd-review` gate |
| design | `DESIGN-QA: <n>` | → `design-qa` + `question` gate; re-run on answers |
| | `TDD-WRITTEN` | → `tdd-review` gate |
| testplan | `TESTPLAN-WRITTEN` | coverage-matrix lint (fail-closed) → `test-review` gate |
| doc stages | `ESCALATE: <r>` | → `escalated` |
| implement | `DONE` | verify task (`test-report.json`) → 4 review passes → `review` |
| review pass | `PASS-COMPLETE: <n>` | merge `findings-<pass>.json` → `review.json` (runner computes fingerprints + thread_ids); when all 4 passes complete → blocker/major → fix run (≤`auto_fix_rounds`); only minor/nit/question remain → `changes-requested` gate |
| | `PASS-FAILED: <r>` | `run_failed` → retry ladder |
| fix | `FIXES-COMPLETE: <f>/<t>` | full re-review round |
| discuss | `REPLIED` | append reply to the thread |
| | `NEEDS-FIX-RUN` | queue fix run |
| ci-fix | `CI-FIXED` | push → `ci-watch` |
| comment-fix | `COMMENTS-PROCESSED: <a>/<t>` | push commits + post replies → `ci-watch` |
| rebase | `REBASED` | force-push → `ci-watch` |
| revert | `REVERT-READY` | push + open revert PR → `ci-watch`; on merge → `reverted` |
| doc-repair | `REPAIRED` | re-lint → resume the interrupted transition |
| | `REPAIR-FAILED: <r>` | `repair` gate item (doc-repair-needed) |
| escalate | `ESCALATION-WRITTEN` | → `escalated` |
| survey | `SURVEY-COMPLETE: <n>` | dossier + semantic rows → DB (`dossier_updated`) |
| | `SURVEY-FAILED: <r>` | `failure` inbox item |
| any | `BLOCKED: <r>` | → `blocked` + `blocked_reason` |

## Scheduling policy

- Implement concurrency: `concurrency.implement` (default 1);
  worktree-isolated same-repo runs may parallelize above 1.
- DAG: `depends_on` children park until parents `merged`.
- Stage timeouts per `timeouts:` block; kill = `aborted`-eligible.

## Run lifecycle

`pending → leased → running → (heartbeats) → exited → collecting →
validated → committed → done | failed | blocked | killed`
(`paused` branches off `running` — see run control)

- **Run control** (API buttons): kill = SIGTERM → SIGKILL after grace;
  pause = SIGSTOP, resume = SIGCONT (`run_paused`/`run_resumed`
  events, `paused` run status). A paused run's lease and timeout keep
  ticking — pause freezes work, not the clock.
- **Subjects**: leases/claims/gate-items key on `(workspace, subject)`
  — ticket id, or `survey:`/`probe:`/`import:`/`interview:` for
  non-ticket runs. Same fencing either way.
- **Retry ladder**: transient run failure → 1 auto-retry same config;
  implement failure → 1 stronger-model retry; then `failed`.
- Sentinel missing/unparseable → `run_failed`, artifacts preserved.
- Structured-doc lint failure → `doc-repair` run → `repair` gate item
  (see recovery workflows).
- Lease expired mid-run (heartbeat dead) → another install may steal;
  loser's commits rejected by CAS. Fencing event logged.
- `spend_cap_usd_per_ticket` OR `tokens_cap_per_ticket` hit →
  `run_killed` + `blocked` reason (dual caps — tokens bound backends
  whose billing isn't $-visible). Cumulative counters live on the
  ticket row; evaluated on every streamed `usage_partial` + run end.
- **Usage accounting**: adapters stream per-message usage where
  supported (ADAPTERS usage contract) → `runs.tokens_*` live-updates →
  run monitor counter; final `usage.json` written at collect (SCHEMAS
  §13 — per-call ledger where the harness exposes calls).

## Special paths

- **Ticket ID allocation**: interview runs reserve `SR-NNNN` at run
  start (`.sprint-runner/next-id` in the tickets repo — claim =
  commit+push, collision → pull-rebase-retry); `WONT-DRAFT` burns the
  number. Split children get ids at materialization (below). Manual
  `tickets/` drops keep the author's id — a collision with an existing
  id gets a flagged inbox item, never an auto-renumber. Imported
  tickets keep tracker keys.
- **Git-ref CAS lock expiry**: `refs/locks/<subject>-<stage>` and
  `refs/locks/claims/<subject>-<gate>` carry JSON content
  `{holder, acquired_at, expires_at}`; every pull sweeps refs past
  `expires_at` (force-delete allowed — a crashed install can't hold a
  lock forever). Refs don't age out on their own; the expiry field IS
  the TTL.
- **Split materialization**: on split-plan approval the conductor —
  not a second agent run — reserves child ids via next-id CAS,
  rewrites child frontmatter (real `id`, `parent`, `depends_on` →
  sibling ids), moves `children/<label>.md` drafts to
  `tickets/<new-id>/ticket.md`, sets the parent → `split`. Reject →
  plan stays in place, ticket returns to triage.
- **Suggestions application**: when triage ends `READY`, the conductor
  writes `suggestions` (backend/model/priority/depth) into frontmatter
  — anything the human set explicitly in the wizard wins.
- **Stale-spec check**: `tickets.spec_hash` = hash of ticket.md + spec
  inputs recorded at spec completion; implement launch re-hashes —
  mismatch → `stale-spec` inbox item + optional re-triage instead of
  implementing stale requirements (PRD §8 mid-flight detection).
- **Shepherd loop**: each open PR polls `gh` checks + review comments
  every `shepherd.poll_interval_s`. Check failure → `ci-fix` run; new
  comments → `comment-fix` run; green + quiet → merge button enabled.
  Per-PR state lives in `ticket_repos` — `merged` only when ALL repos'
  PRs merge (mixed per-repo states render on S-05/S-09).
- **DoD at merge**: `test.md` DoD rows with `verified_by: cmd:<…>`
  execute as a verify task before merge enables; `manual` rows are a
  human attest checkbox on the review/PR page.
- **Collision warning**: tickets whose `entities_referenced`/file plans
  overlap an in-flight ticket get a `conflicts_with` note on the ticket
  + an inbox item. Warn-only — never blocks; the rebase run handles the
  real conflict when it lands.
- **Doc approval — primary in-app, mirrored as PR**: in the app the
  S-06 reviewer approves directly (status commit). As a secondary
  channel, the conductor also opens `docs/<ticket>-<stage>` PRs on the
  tickets repo — merge = `doc_approved`, comments = `doc_feedback` →
  revision run — so github.com-only reviewers never block the loop.
  Both directions sync: an in-app approve merges the mirror PR.
  Q&A answers: wizard in-app, `## Triage` checklist as the mirror.
- **Doc-repair (context-dependent)**: lint failure on an agent-written
  doc (tdd/test/review artifacts) → ONE `doc-repair` run attempts a
  format fix → still fails → `repair` gate item (doc-repair-needed).
  Human-authored content (ticket.md edits from github.com) goes
  STRAIGHT to human — never auto-rewrite a human's work.
- **Dossier wait (depth-gated)**: `light`/`standard` tickets flow with
  `dossier: pending` injected instead of `{{DOSSIER}}` (flagged on the
  ticket); `deep`-tier tickets park until their scope's dossier exists.
- **Cost estimate at the "go" checkpoint**: the implement approval shows
  an estimate — stage defaults from config until the ledger has real
  data, then median-of-similar-tickets (by entities + depth + repo).
- **Schema versioning**: migrate-on-touch — when the conductor writes a
  doc whose `schema:` is older than current, it upgrades the format in
  the same commit. Dormant tickets stay v1 until touched.

## Reconcile-on-open

Not a separate path: the conductor IS the babysitter — "opening the
app" attaches the UI to an already-running conductor. Same reconcile
pass, no second code path.
