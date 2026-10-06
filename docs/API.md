# API — conductor UI surface contract

Companion to `CONDUCTOR.md`. Draft 2026-10-03.
The conductor serves the web UI over HTTP on `ui.bind`:`ui.port`
(default `127.0.0.1:4711`). One surface — the desktop shell's webview
and any browser (daemon mode) hit the identical API. Wire protocol:
**REST + SSE**. This doc pins auth, resources, and the live channel;
payload shapes come from `SCHEMAS.md`/`DB-SCHEMA.md`.

## Auth — always on, no exceptions

- Every request requires `Authorization: Bearer <token>` — API calls,
  SSE connections, and static assets alike.
- Token: 32-byte random hex, generated on first launch, written to
  `ui.token_file` (default `~/.config/veto/ui-token`,
  mode `0600`). Never logged, never committed, never echoed by the API.
- The desktop shell reads the token file and injects the header into
  webview requests. Browser/daemon users bootstrap once via
  `GET /?token=<token>` on `127.0.0.1` → server sets a session cookie;
  the query-param path is **refused on non-loopback binds**.
- `ui.remote_access: true` widens `bind`; the token is still required
  on every request including the SSE stream, and config warns on save.
  Rationale (unchanged from CONDUCTOR): agents on this machine execute
  arbitrary code — an unauthenticated localhost surface is a
  CSRF→RCE door.

## Conventions

- Base path `/api/v1` · JSON bodies · errors `{error, message, refs?}`
  with 4xx/5xx.
- Ids are workspace-qualified: `ticket_ref` = `<workspace>/<ticket_id>`
  on anything that touches a ticket (`SR-NNNN` is unique per
  project/workspace only — see DB-SCHEMA workspace keying).
- Gate writes carry `expected_status` and are idempotent — a stale
  submission (another install cleared the gate first) gets `409`, not
  a double-commit. Claims/leases make collisions visible; this makes
  them safe.

## Resources

| Path | Verbs | Backs |
| --- | --- | --- |
| `/inbox` | GET | S-01 inbox tab — unified `gate_items`, ranked human-anxiety-first → priority → age (D21); `?workspace=` filter |
| `/board` | GET | S-01 board tab — tickets grouped by `phase` column (Backlog·Spec·Build·Review·Done), each card carrying `attention` (open gate_items) and `drop_targets` (allowed drag actions — server-computed, UI only highlights; invalid drops rejected, never trusted client-side); `?workspace=` filter |
| `/tickets` | GET | S-01/S-05 lists — `tickets` rows (filters: status, repo, workspace, feature) |
| `/boards`, `/initiatives`, `/features` | — | **Draft (D26/D27, FEATURES.md §7):** S-15–S-18 — idea boards, board items, scoped synthesize, entity CRUD, re-plan/re-parent, provenance amendments. Not implemented; contract TBD in the board work package |
| `/capture` | POST | **Draft (D27):** tray/feedback ingress — creates a `board: null` board_item (kind text/feedback/link/voice); sources: CLI `veto add`, `⌘⇧C` modal, webhook/email, mobile route |
| `/tickets/<ref>` | GET | S-05 — ticket row + latest `ticket.md` doc_version + triage artifact + family rail |
| `/tickets/<ref>/docs/<name>` | GET | S-06 — rendered rs/tdd/vs from `doc_versions` + version diffs. `<name>` is a bare doc name (`rs`, `tdd`, `vs`, `ticket`, …) or full `DOC_KINDS` kind (`rs.md`); legacy aliases `prd`/`prd.md`→`rs.md`, `test`/`test.md`→`vs.md` are accepted because stage/gate ids kept pre-rename vocabulary (wp-111) |
| `/tickets/<ref>/events` | GET | S-05 Activity / S-11 ledger slice |
| `/tickets/<ref>/answers` | POST | S-04 wizard answers (single or batch) → commit → re-run |
| `/tickets/<ref>/docs/<name>/feedback` | POST | S-06 comment → `doc_feedback` → revision run |
| `/tickets/<ref>/docs/<name>/approve` | POST | S-06 approve → `doc_approved` (+ merges mirror PR) |
| `/tickets/<ref>/review` | GET | S-08 — latest `review.json` run_artifact for the ticket (404 when absent; 502 on corrupt JSON — fail-closed) |
| `/tickets/<ref>/findings/<fid>/verdict` | POST | S-08 accept / dismiss / wontfix |
| `/tickets/<ref>/actions` | POST | `go_implement` (spend checkpoint), `open_pr`, `merge`, `revert`, `send_back`, `force_ready`, `wont_do`, `handoff`, `resume`, `retry`, `approve_split`, `waive_quality` (wp-111 — human waiver of the `rs-quality` gate → `gate_overridden` event; clears the gate, never approves or mutates rs.md) |
| `/runs`, `/runs/<id>` | GET | S-07 monitor — registry + artifact listing |
| `/runs/<id>/kill` `/pause` `/resume` | POST | process runs: SIGTERM→SIGKILL / SIGSTOP / SIGCONT; container runs: `docker kill` / `docker pause` / `docker unpause` (D30) |
| `/workspaces` | GET, POST | S-13 — projects (`projects` rows) + per-project queue counts; add |
| `/interview` | POST | S-03 — `{workspace, text}` → new-ticket interview run; edit mode `{workspace, ticket_ref, message, target?, session_id?}` → chat-to-edit turn, proposes `proposed-diff.md` (SCHEMAS §16). **D27:** `ticket_ref` generalizes to `subject_ref` (`IN-x`/`FE-x`/`SR-x`) — same dir-scoped diff rules applied to the entity's doc dir |
| `/interview/<session>/approve` `/interview/<session>` | POST, DELETE | S-05 focus rail — apply / discard the session's pending diff → `doc_versions` write + `doc_edited` event + version bump |
| `/import` | POST | S-03 — source + query → preview rows → commit |
| `/settings` | GET, PUT | S-02 — config.yaml fields; secrets are write-only (never read back) |
| `/kb/<scope>` | GET, PUT | S-14 dossier sections; PUT = human edit → `dossier_edited` |
| `/kb/<scope>/sync` | POST | manual survey run |
| `/evidence/search` | POST | D37 hybrid evidence lookup → `retrieval-evidence.json`; server derives authorized project/repo scope from the subject/session and rejects client attempts to widen it |
| `/links` | GET, POST | D37 traceability graph (wp-111). GET lists edges for `?workspace=&subject=` with provenance/confidence/verification/`valid_at`; POST proposes an edge — model/tool proposals land `suggested`/`auto-verified`, never `verified` |
| `/links/decide` | POST | D37 human verify/reject, OCC `{expected}` (the state the human saw — a racing write 409s). Idempotent + evented (`link_verified`/`link_rejected`); stale or out-of-scope evidence can never verify (wp-111) |
| `/evidence/source` | GET | wp-111 — resolves a pinned `code:` citation to `{ref, unit, current|stale}` for navigable citations; 400 unparseable · 403 unconfigured repo · 404 missing unit |
| `/tickets/<ref>/rs-quality` | GET | S-06 — latest `rs-quality.json` run_artifact (the cited AI quality pass; advisory findings, not a score — never approves rs.md). 404 absent · 502 corrupt (fail-closed) |
| `/repositories/<repo>/index` | GET, POST | D37 code-index head/status; POST requests incremental index of the authorized current default-branch SHA (never accepts arbitrary filesystem paths) |
| `/alignment/<scope>` | GET, POST | Phase B (D37, wp-112): GET returns the latest durable `alignment-findings.json` + findings + run history for `?workspace=`; POST `{workspace, trigger?, trigger_sha?}` requests a fresh intended/implemented/verified comparison — `on-merge` runs coalesce on (scope, trigger_sha) → 200 with the existing run; `intelligence.alignment: off` → 409; configured token/spend cap reached → 429 |
| `/alignment/decide` | POST | wp-112 human dismiss/verify/resolve/reopen on a finding: `{workspace, id, action, expected, rationale?}` — OCC (`expected` = the status the human saw; a racing write 409s), idempotent, evented (`alignment_finding_decided`), append-only audited; never mutates a spec/link/gate |
| `/alignment/<scope>/readiness` | GET | wp-112 — `release:<id>` scopes only: deterministic release-gate checks PLUS the advisory risk narrative (`gate_verdict` is gates-only — the narrative can never turn a failed gate green). 400 non-release scope · 404 unknown release |
| `/feedback/clusters` | POST | wp-112 — `{workspace, board?}` → semantic cluster proposals over `kind: feedback` board items; proposes only (never creates board/initiative work), preserves original refs, strictly workspace-scoped |
| `/telemetry/sources`, `/incidents` | — | Phase C (D37), deferred: sanitized connector administration, error-signature list, incident investigation, and human-approved draft-ticket proposal; raw telemetry is queried in its source backend, not returned by default |
| `/metrics` | GET | S-12 — dashboard aggregates from `events`/`usage_calls`; includes `accepted_outcomes` + `cost_per_accepted_outcome` (wp-155, PRD §15.12: total inference+retry+execution+remediation spend over outcomes that reached `merged`/`released` — never per-call price; `null` when no outcome has landed) |
| `/gate-items/<id>/claim` `/release` | POST, DELETE | shared-queue claiming |
| `/gate-items/<ws>/<subject>/<gate>/snooze` | POST | D20 snooze — `{until}` ISO (or `{for_minutes}`) → `snoozed_until`; hidden from `/inbox` + badge until then (`?include_snoozed=1` reveals) |

## Live channel — `GET /api/v1/stream` (SSE)

One event source per client:

| event | payload | drives |
| --- | --- | --- |
| `gate_surfaced` / `gate_cleared` | gate_item row | S-01 inbox, badge counts |
| `run_status` | run row delta | status steppers, monitor |
| `run_output` | `{run_id, chunk}` | S-07 transcript tail |
| `usage_partial` | `{run_id, tokens_in, tokens_out, tokens_cached}` | live counters — internal stream, **not** a ledger event (SCHEMAS §7) |
| `index_status` | `{workspace, repo, commit_sha, status, stats?}` | D37 repository intelligence freshness and background-index progress |
| `alignment_status` | `{scope, run_id, status, finding_count?}` | Phase B alignment run progress; final artifact is durable |
| `notification` | notification row | desktop toasts |

Every streamed fact is also written durably (`events` rows, other DB
rows, run_dir log files) — the stream is a latency optimization, never
the only copy; a reconnecting client re-reads state, no replay
protocol needed.
