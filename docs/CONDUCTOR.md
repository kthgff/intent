# CONDUCTOR — the Veto engine spec

Companion to `PRD.md`. Draft 2026-10-03; revised 2026-10-04 (D30 —
containerized run runtime).
The conductor is the control loop that moves tickets through the state
machine. One per install (embedded in the app; `veto daemon` =
the same loop headless). It is a **watcher + scheduler, not a worker** —
stage runs execute inside **persistent per-subject Docker containers**
(D30) for container-capable backends (`aider` in v1); process-run
backends (`devin`) keep detached OS processes + their own sandbox. The
conductor itself NEVER runs inside a container — it owns the docker
daemon socket, the worktrees, and all environment-touching steps.

## Processes

- **Conductor** (persistent helper process — "the babysitter"): starts
  with the app/login item, watches the run registry, schedules stage
  runs, owns transitions, reconciles continuously. The pipeline moves
  overnight; gates wait for humans by definition.
- **Runs** (detached): one execution per stage-run — a `docker exec`
  session inside the subject's container for `runtime: container`
  backends, else a spawned OS process. Writes artifacts per
  `{{ARTIFACT_TARGETS}}`, exits with a last-line sentinel.
- **Ticket containers** (D30): one persistent Docker container per
  subject (ticket), created LAZILY on its first repo-executing stage —
  cardless doc stages before that run on the host. Named
  `veto-<workspace>-<subject-slug>`, labeled
  `veto/subject=<ws>/<subject>` +
  `veto/managed=true`, image `containers.image`, resource caps
  `containers.cpu`/`containers.memory`. Bind-mounts every worktree in
  the subject's `ticket_repos` rows (one container, N mounts for
  multi-repo tickets — never N containers). Lifecycle: `docker stop`
  when the ticket parks at a gate; `docker start` on next launch;
  `docker rm` on terminal status. See "Container lifecycle" below.
- **Runner tasks** (conductor-side compute — split by cost): cheap
  mechanical checks run INLINE in the tick (spec-lint scoring,
  coverage/doc lint, fingerprints, file-plan-vs-diff check,
  gitleaks); heavy executions —
  repo-card suite re-runs for pre-flight and `test-report.json` —
  are DETACHED `verify` tasks: registered in `runs` like stage runs,
  own timeout (`timeouts.verify`), no agent involved. A 20-minute
  suite never stalls a 10s tick.
- **Evidence workers** (D37): background, non-agent tasks ingest authorized
  repository commits into a temporary commit-pinned index, parse symbols/
  relations, write FTS + embeddings, run safety/evaluation checks, then
  atomically advance `repo_indexes.status = current`. A partial/failed index is
  retained for diagnostics but never served as current. Phase-C telemetry
  workers apply authorization + redaction before normalization,
  fingerprinting, persistence, embedding, or model access.
- **UI surface** (HTTP on localhost): the conductor serves the web UI
  itself — the desktop shell is a bundled webview pointed at it, and a
  headless daemon serves the identical UI to any browser. Wire
  contract = **REST + SSE**, specified in `API.md`. **Security:**
  bound to `127.0.0.1` by default (agents execute arbitrary code by
  design — an unauthenticated localhost surface is a CSRF→RCE door);
  bearer-token auth always (provisioned via `ui.token_file` — API.md);
  binding wider (LAN/tunnel remote access) requires explicit
  `ui.remote_access` + token on every request, warned in config.

## The loop (fires every ~10s tick + on run-exit + on external writes)

Revised 2026-10-04 (D29): there is no tickets repo — nothing to pull,
nothing to project. The `tickets`/`ticket_repos` rows ARE the truth;
external changes arrive through the API (`doc_versions` writes,
gate actions, imports) and the conductor reads the DB directly.

1. **RECONCILE**
   - For each live run: process exited → collect artifacts → parse
     LAST non-empty line sentinel → extract usage → write the
     `usage.json` `run_artifacts` row → validate structured outputs
     (fail-closed lint) → **sanitizer scan** (`security.scanner` —
     fail-closed; a scan error or finding surfaces a `repair` gate
     item and blocks any code-repo push) → write status + artifacts +
     events → release lease → check auto-advance.
   - Heartbeats are **conductor-observed**: each tick records process
     liveness (host pid, or `docker inspect` state + exec'd process for
     container runs) + artifact/log mtime into `runs.heartbeat_at` —
     the run never touches the DB. Dead → `stalled` warn; timeout
     exceeded → kill, preserve worktree, `run_killed` event, status
     stays for retry.
   - New `gate_items` row OR `run_failed`/`run_killed`/`blocked` →
     `notifications` row → SSE + desktop/badge per settings.
   - Observe configured repository default-branch heads. A changed SHA queues
     one incremental index job per repo; duplicate `(workspace, repo, sha)`
     work coalesces. Index failure marks evidence stale and notifies, but does
     not silently substitute a partial index.
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
   - Acquire lease (DB row insert — contested → skip this tick).
3. **LAUNCH**
   - Repo-executing stages (implement, fix, ci-fix, comment-fix,
     rebase, revert, verify): create worktree(s) `<repo>.worktrees/<id>`
     + branch(es) — one `ticket_repos` row per repo in `repos:`.
   - **Container ensure** (`runtime: container` backends): create the
     subject's container if absent (bind-mount every current
     `ticket_repos` worktree) or `docker start` if stopped. If the
     ticket's repo set grew since create → recreate the container so
     the new mount lands (container state is disposable; the worktree
     holds everything that matters).
   - Interview: allocate a fresh `SR-NNNN` at run start
     (`projects.next_ticket_seq`, transactional — a `WONT-DRAFT` just
     burns the number; ids needn't be contiguous).
   - For PRD/design/testplan/implement/review intelligence consumers, request
     an authorized evidence bundle using the subject's project/repo scope.
     Validate `retrieval-evidence.json` fail-closed, enforce freshness policy +
     token budget, and render explicit `no relevant evidence` when empty.
   - Render prompt (token table per prompt file), inject
     `{{ARTIFACT_TARGETS}}` per backend `can_write_outside_tree` and
     resolve `{{GOALS}}` — walk ticket→feature→initiative `serves`
     chain + direct edges → goal `board_items` bodies (D33;
     `"no stated goal"` when empty), plus `{{EVIDENCE_BUNDLE}}` for D37
     consumers. Retrieved excerpts are delimited untrusted data, never prompt
     instructions.
   - Launch detached — `docker exec` in the subject's container for
     container backends, else spawn — register run row (`subject` =
     ticket id, or `survey:<scope>:<name>` / `probe:<repo>` /
     `import:<source>` / `interview:<run>` for non-ticket runs) +
     heartbeat + `runs.container_id`.

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
| | `TICKET-AUTHORED: <id>` | insert `tickets` row + `ticket.md` doc_version → `imported` |
| | `WONT-DRAFT: <r>` | burn the reserved id, notify |
| import | `IMPORTED: <n>` | insert ticket rows + doc_versions, each → `imported` |
| | `IMPORT-FAILED: <r>` | `failure` inbox item |
| probe | `CARD-WRITTEN` | persist card (`verified` per probe's own report) |
| | `PROBE-FAILED: <r>` | card `verified: false` + inbox item |
| triage | `READY` | apply `suggestions` to the ticket row (human wizard edits win) → `ready` → auto `prd-draft` |
| | `NEEDS-INFO: <n>` | → `needs-info` + `question` gate |
| | `ESCALATE: needs split` | queue `split` run |
| | `ESCALATE: <other>` | → `escalated` |
| split | `SPLIT-PROPOSED: <n>` | store `split-plan.md` + child drafts in `run_artifacts` → `split-plan` gate |
| | `UNSPLITTABLE: <r>` | → `escalated` |
| prd | `PRD-WRITTEN` | → `prd-review` gate |
| design | `DESIGN-QA: <n>` | → `design-qa` + `question` gate; re-run on answers |
| | `TDD-WRITTEN` | → `tdd-review` gate |
| testplan | `TESTPLAN-WRITTEN` | coverage-matrix lint (fail-closed) → `test-review` gate |
| doc stages | `ESCALATE: <r>` | → `escalated` |
| implement | `DONE` | verify task (`test-report.json`) → 4 review passes → `review` |
| verify | `DONE` | `verify_cmd` + `app_url` smoke pass → `verify-confirm` human gate → `released`; failure → `verify_failed` → fix run (D27) |
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
| release-notes | `DONE` | `notes-<audience>.md` drafts registered as release_notes rows; human approves per audience before `published_at` (wp-135, DELIVERY §5); missing docs → repair gate |
| retro | `DONE` | `retro.md` doc_version + draft board proposals → `retro_completed` (wp-135, DELIVERY §7 — proposals never commit scope) |
| any | `BLOCKED: <r>` | → `blocked` + `blocked_reason` |

## Scheduling policy

- Implement concurrency: `concurrency.implement` (default 1);
  worktree-isolated same-repo runs may parallelize above 1 — N
  parallel tickets = N running containers, each independently
  CPU/memory-capped.
- DAG: `depends_on` children park until parents `merged`.
- Stage timeouts per `timeouts:` block; kill = `aborted`-eligible.

## Run lifecycle

`pending → leased → running → (heartbeats) → exited → collecting →
validated → committed → done | failed | blocked | killed`
(`paused` branches off `running` — see run control)

- **Run control** (API buttons): process runs — kill = SIGTERM →
  SIGKILL after grace; pause = SIGSTOP, resume = SIGCONT. Container
  runs — kill = `docker kill --signal=TERM` grace → `docker kill`
  (stops the container; restarted on next launch); pause =
  `docker pause`, resume = `docker unpause` (freezes the whole
  container cgroup — the exec'd run process included). Same
  `run_paused`/`run_resumed` events + `paused` run status either way.
  A paused run's lease and timeout keep ticking — pause freezes work,
  not the clock.
- **Subjects**: leases/claims/gate-items key on `(workspace, subject)`
  — ticket id, or `survey:`/`probe:`/`import:`/`interview:` for
  non-ticket runs. Same fencing either way.
- **Retry ladder**: transient run failure → 1 auto-retry same config;
  implement failure → 1 stronger-model retry; then `failed`.
- Sentinel missing/unparseable → `run_failed`, artifacts preserved.
- Structured-doc lint failure → `doc-repair` run → `repair` gate item
  (see recovery workflows).
- Lease expired mid-run (heartbeat dead) → another install may steal;
  the stale holder's next DB write fails its lease check. Fencing
  event logged.
- `spend_cap_usd_per_ticket` OR `tokens_cap_per_ticket` hit →
  `run_killed` + `blocked` reason (dual caps — tokens bound backends
  whose billing isn't $-visible). Cumulative counters live on the
  ticket row; evaluated on every streamed `usage_partial` + run end.
- **Usage accounting**: adapters stream per-message usage where
  supported (ADAPTERS usage contract) → `runs.tokens_*` live-updates →
  run monitor counter; final `usage.json` written at collect (SCHEMAS
  §13 — per-call ledger where the harness exposes calls).

## Special paths

- **Ticket ID allocation**: interview runs allocate `SR-NNNN` at run
  start via `projects.next_ticket_seq` — `UPDATE … RETURNING` inside
  the ticket insert's transaction (D29; `WONT-DRAFT` burns the
  number). Split children get ids at materialization (below).
  Imported tickets keep tracker keys.
- **Lease expiry (DB-only)**: `leases.heartbeat_at` + `ttl_s` carry the
  TTL — every reconcile tick sweeps rows past expiry. A crashed
  install can't hold a lock forever.
- **Split materialization**: on split-plan approval the conductor —
  not a second agent run — allocates child ids transactionally,
  inserts the child `tickets` rows + `doc_versions` bodies (real
  `id`, `parent`, `depends_on` → sibling ids), sets the parent →
  `split`. Reject → plan stays in `run_artifacts`, ticket returns to
  triage.
- **Suggestions application**: when triage ends `READY`, the conductor
  writes `suggestions` (backend/model/priority/depth) onto the ticket
  row — anything the human set explicitly in the wizard wins.
- **Stale-spec check**: `tickets.spec_hash` = hash of ticket.md + spec
  inputs recorded at spec completion; implement launch re-hashes —
  mismatch → `stale-spec` inbox item + optional re-triage instead of
  implementing stale requirements (PRD §8 mid-flight detection).
- **Evidence freshness** (D37): a bundle records every repo index head. Before
  implementation/review/release use, compare it to the configured current
  default-branch SHA. When `intelligence.allow_stale = false`, a mismatch
  queues reindex/retrieval; when true, stale citations remain explicitly
  labeled and cannot verify an AC/link.
- **Pre-PRD grounding** (D37): existing-product subjects request code/dossier
  evidence before `prd-draft`. No result is a valid artifact and is stated in
  the PRD context; malformed/unauthorized evidence blocks rather than allowing
  the model to guess. Greenfield subjects may proceed with `code evidence:
  none (greenfield)`.
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
- **Doc approval — in-app only (D29)**: the S-06 reviewer approves
  directly — approve = a `doc_versions` write + status update + gate
  clear, all transactional. There is no tickets-repo mirror PR;
  github.com-only reviewers are served by the web UI itself.
- **Doc-repair (context-dependent)**: lint failure on an agent-written
  doc (tdd/test/review artifacts) → ONE `doc-repair` run attempts a
  format fix → still fails → `repair` gate item (doc-repair-needed).
  Human-authored content (ticket doc edits via UI/API) goes
  STRAIGHT to human — never auto-rewrite a human's work.
- **Dossier wait (depth-gated)**: `light`/`standard` tickets flow with
  `dossier: pending` injected instead of `{{DOSSIER}}` (flagged on the
  ticket); `deep`-tier tickets park until their scope's dossier exists.
- **Goal question (non-board-born subjects)**: at triage/interview,
  when the project has ≥1 `active` goal and the subject has no
  `serves`, the wizard adds "which goal does this serve?" (`single`,
  options = active goals + none/new). Answer writes `tickets.serves`
  (+ a `serves` edge if the subject has a board card); "new" drafts a
  `lane`-mode goal sticky (D33).
- **Cost estimate at the "go" checkpoint**: the implement approval shows
  an estimate — stage defaults from config until the ledger has real
  data, then median-of-similar-tickets (by entities + depth + repo).
- **Schema versioning**: migrate-on-touch — when the conductor writes a
  doc whose `schema:` is older than current, it upgrades the format in
  the same `doc_versions` write. Dormant docs stay v1 until touched.

## Container lifecycle (D30)

One Docker container per subject, owned by the conductor, recorded in
the `containers` table (`workspace, subject, container_id, image,
state`). The worktree is the durable state; the container is
disposable execution context — losing one never loses work.

- **Create (lazy)** — at the first repo-executing launch for the
  subject. `docker create` with: image `containers.image` (single
  shared agent image — git, gh, aider, runtimes; repo-specific deps
  install inside via repo-card setup), bind-mounts
  `-v <worktree>:<worktree>` for every `ticket_repos` row (same
  absolute path inside and out — sentinel/artifact paths rendered into
  prompts stay valid on both sides), caps `--cpus`/`--memory`, labels
  `veto/managed=true` + `veto/subject`. Cardless doc
  stages (triage, prd, design, testplan, interview) run on the host if
  they arrive before the first repo-executing stage — the container
  exists only when it has code to execute against.
- **Gate sleep** — when the ticket enters a gate status, `docker
  stop`. Parked days-long gates hold a row and a filesystem, not RAM.
- **Wake** — next launch `docker start` + `docker exec`. Mount set
  fixed at create; `repos:` growing mid-flight → recreate.
- **Exec model** — runs are `docker exec -w <worktree> -e <secrets>`
  inside the container; stdout/stderr stream to `run_dir` logs exactly
  like a spawned process — sentinel parsing, usage extraction, and
  artifact collection are runtime-agnostic. Secrets ride the exec env
  (`OPENROUTER_API_KEY` et al.), never argv beyond `-e` names.
- **Kill/pause** — `docker kill` (SIGKILL after TERM grace) stops the
  container and its run; `docker pause`/`unpause` for pause/resume.
- **Teardown** — terminal ticket status → `docker rm` + worktree
  cleanup (existing convention); containers row → `removed`.
- **Orphan sweep** — conductor startup lists
  `label=veto/managed=true`; any container with no live
  `containers` row or a subject in terminal state is removed — a
  crashed babysitter can't leak containers.
- **Docker is a PATH dep** for container backends: absent daemon →
  clean startup error, same rule as gitleaks/gh. Container runtime
  applies to the `aider` backend in v1; `devin` keeps host processes +
  `--sandbox` (`runtime: process` fallback exists for both — SETTINGS).

## Reconcile-on-open

Not a separate path: the conductor IS the babysitter — "opening the
app" attaches the UI to an already-running conductor. Same reconcile
pass, no second code path.
