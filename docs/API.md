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
| `/board` | GET | S-01 board tab — tickets grouped by `phase` column (Backlog·Spec·Build·Review·Done), each card carrying `attention` (open gate_items), `drop_targets` (allowed drag actions — server-computed, UI only highlights; invalid drops rejected, never trusted client-side), and `delivery` (wp-137, DELIVERY §8 — the ticket's strongest `release_items.delivery_state` + release id, or null; the two-dimension card display); `?workspace=` filter |
| `/tickets` | GET | S-01/S-05 lists — `tickets` rows (filters: status, repo, workspace, feature) |
| `/boards` | GET, POST | S-15/S-16 idea boards (§15.3, wp-144). GET `?workspace=` lists boards + per-type config; POST `{workspace, board, name?, org?, board_type?, status?}` → 201. Board type is config, not a pipeline |
| `/boards/<board>` | GET | S-16 canvas — board row + `type_config` + `items`: every board_item paired with its extracted statements (`boardSurface`) — the statement surface per item |
| `/boards/<board>/items` | POST | Typed sticky `{workspace, kind?, note_kind?, topic?, importance?, applies_to?, note_status?, rationale?, title?, body?, ref?, zone?, serves?, x/y/w/h?}` → 201. Fail-closed on unknown taxonomy values |
| `/boards/<board>/status` `/resurface` `/resurface/accept` `/spawn` `/extract` `/reference` | POST | wp-144 lifecycle + handoffs: resurface is always an approval-required proposal; `extract` ingests a `statements.json` batch (verbatim-gated, atomic); `reference` cites an approved doc or files a ChangeSet (`request` present) — approved items never mutate |
| `/board-items/<id>/statements` | GET | S-16 inspector — one item + its statements |
| `/board-items/<id>` | PATCH, DELETE | S-16/S-20 item mutation (wp-147). PATCH is OCC-fenced: `expected_updated_at` must match the row or 409; consumed/frozen items are supersede-only → 409. Tray→board moves route through the engine's promotion rule. DELETE refuses consumed/frozen (supersede, never delete) |
| `/boards/meta/taxonomy` | GET | The closed enums + per-type config the UI renders (board types, note kinds/importances/statuses) |
| `/tray` | GET | S-20 project tray — `board: null` items (`?workspace=`, `?kind=`) |
| `/interview-wizards` | GET | The versioned wizard catalog (`?workspace=`): MVP configs + declared slots + thresholds (draft ⊆ approval). Read-only; definitions seed idempotently on session start |
| `/interview-sessions` | GET, POST | §15.9 orchestrator sessions (wp-145/147) — distinct from the chat-to-edit `/interview/<session>` surface. GET `?workspace=&status=&subject=`; POST `{workspace, wizard_id, subject?, mode?, session_id?, branch?, role?}` → 201 (seeds the slot rows; idempotent on session id) |
| `/interview-sessions/<id>` | GET | Session detail: session + slots + questions + `pending_question` + durable transcript + explainable readiness + branches |
| `/interview-sessions/<id>/answer` | POST | `{workspace, answer, question_id?, slot?, slots?}` — the answer persists durably BEFORE any next question is generated (engine-enforced); one answer may satisfy many slots |
| `/interview-sessions/<id>/mode` `/status` `/pause` `/resume` | POST | Three input modes (`conversation`/`guided`/`bulk`) switchable without loss; `resume` returns the knowledge-diff briefing ("what changed since you left") |
| `/interview-sessions/<id>/questions/<q>/resolve` | POST | `{status: answered\|skipped\|unanswerable, reason?}` — `unanswerable` defers the slot and is never re-asked |
| `/interview-sessions/<id>/slots/<slot>` | POST | `{state: known\|not-applicable\|deferred}` — `known` is the human confirmation step (confirms every proposed statement bound to the slot) |
| `/interview-sessions/<id>/understanding` | GET | **Understanding Panel** (wp-146 contract, wp-147 route): `confirmed` / `interpretation` / `needs_clarification` / `decision_required` buckets of session-bound statements+slots+open decisions+clarifications, each carrying provenance (`source_ref`, `extraction_run`, `version`) — explainable indicators, never a score |
| `/statements` | GET | Statement Ledger list (`?workspace=&status=&intent=&scope=&scope_ref=&subject=`); rows carry `open_decisions` count |
| `/statements/<id>` | GET | Statement detail — head + version history + relations (out/in) + decisions + clarifications + artifact links |
| `/statements/<id>/decide` | POST | `{action: confirm\|dispute\|reject, reason?}` — human lifecycle via the engine: confirm upgrades provenance to stakeholder-verified; dispute opens a decision item (idempotent); reject retires (never deletes) |
| `/statements/<id>/correct` | POST | `{text, session_id?, slots?}` → a NEW confirmed statement + `supersedes` edge on the old one — correction edits write versioned history, never silent overwrites (wp-147); optional slot rebinding feeds the correction back into the session |
| `/statement-decisions/<id>/decide` `/dismiss` | POST | Rule an open decision item (`{decision, rationale?, apply?}` optionally applies the outcome to the bound statement) or dismiss it |
| `/features` | GET | S-17 (wp-152) — feature rows (`?workspace=&initiative=&status=` filters) |
| `/features/<ws>/<feature>` | GET | S-17 detail rollup — feature row + initiative + doc_versions metadata + member tickets grouped by work_type×status + requirement links (`documents`/`implements` relations; **primary** = first verified `documents` edge) + **health** (explainable findings list — `blocked_ticket`/`failed_ticket`/`open_gate`/`unverified_ac`/`stale_approval`/`undelivered_ticket`/`not_accepted`/`no_tickets`, each with evidence `refs`, never a score) + acceptance state + release memberships/exposure/deployments + subject events |
| `/features/<ws>/<feature>/docs/<name>` | GET | S-17 Design/Requirements tabs — versioned feature docs (`feature.md`/`ac.md`/`vs.md`/`notes.md`/`mockup.json`/`adr.md`/`provenance.json`), bare names or full kinds; consecutive-version diffs computed server-side. 400 on other doc kinds, 404 absent |
| `/features/<ws>/<feature>/acs` | GET | S-17 Quality tab — AC evidence matrix: `ac.md` rows joined with verified traceability edges (`verified-by`/`tests`/`implements` on `ac:<id>`; suggested edges never verify) |
| `/features/<ws>/<feature>/acceptance` | GET | S-17 Release tab — the Feature Acceptance Package: approved scope revision (feature.md + its `doc_approved` event) + AC slice + docs inventory + member-ticket delivery evidence (status + merged refs) + known exclusions + live findings — the bundle the human judges |
| `/features/<ws>/<feature>/accept` | POST | **The explicit human acceptance gate** (PRD §15.7): `{exclusions?, expected_status?}` → durable `doc_approved` event (`data.doc='acceptance-package'`) + feature status `done`. The ONLY path to `done` — `addReleaseItem` refuses unaccepted features (`not-approved`). Stale `expected_status`/repeat accept → 409; `discarded` → 409 |
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
| `/interview` | POST | S-03 — `{workspace, text}` → new-ticket interview run; edit mode `{workspace, ticket_ref, message, target?, session_id?}` → chat-to-edit turn, proposes `proposed-diff.md` (SCHEMAS §16). **D27:** `ticket_ref` generalizes to `subject_ref` (`IN-x`/`FE-x`/`SR-x`) — same dir-scoped diff rules applied to the entity's doc dir. **wp-152:** `F-*` subjects are implemented — the "Ask About This Feature" scoped assistant; targets `feature|ac|vs|notes` (the feature's own doc evidence only) |
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
| `/telemetry/sources` | GET, POST | Phase C (D37, wp-120). GET `?workspace=` (`&enabled=`) lists `telemetry_sources`. POST `{workspace, id, kind, config?, redaction_policy?, enabled?}` registers/updates a source → 201; `config` carries secret REFS only (`env:NAME`/`ref:…`/`$NAME`) — a literal-looking value on a secret-ish key → 400; unknown `kind` (otlp\|loki\|opensearch\|file\|journald\|docker) → 400 |
| `/telemetry/ingest` | POST | wp-120 connector write: `{workspace, source_id, events[]}` → sanitize (secrets/PII/request bodies stripped BEFORE any persistence; unclassifiable event fails the whole batch → 400) → fingerprint → dedupe onto `error_signatures` (count/last_seen only — raw events never stored). New or regressed signatures open `INC-NNNN` incidents; a live open/investigating incident absorbs repeats (no duplicate investigations). Unknown source → 404, disabled → 409 |
| `/telemetry/signatures` | GET | `?workspace=&source_id=` — the deduplicated sanitized signature rows; counts/time windows served from these structured rows, never vector retrieval |
| `/incidents` | GET | `?workspace=&status=&signature_id=` — `incidents` rows + draft-ticket proposals |
| `/incidents/<id>` | GET | `?workspace=` — incident + latest validated `incident-investigation.json` (corrupt stored artifact → 502, fail-closed) + `incident_decisions` audit + proposals. 404 unknown |
| `/incidents/<id>/investigate` | POST | `{workspace}` — deterministic correlation (deployments in the observed window, release members, prior verified resolutions) → NEW `incident-investigation.json` doc_version + `investigation_ref`. 404 unknown incident |
| `/incidents/decide` | POST | `{workspace, id, action: investigate\|resolve\|close\|reopen, expected, rationale?, evidence?}` — OCC (`expected` = the status the human saw → 409 stale), idempotent, append-only audited, `incident_decided` event. `resolve` REQUIRES `evidence` refs (deployment/ticket/pr) → 400 otherwise; a resolved incident carries `resolution_verified=1`, `reopen` clears it |
| `/incidents/<id>/proposals` | POST | `{workspace, title, body?, draft?}` → 201 `draft` `incident_ticket_proposals` row + `draft_ticket_proposed`. A proposal never creates scope itself |
| `/incidents/proposals/decide` | POST | `{workspace, id, action: approve\|reject, expected, rationale?}` — the draft-ticket gate (OCC → 409, idempotent). `approve` lands ONE capture-tray board item (kind `ticket`, `provenance: inferred` — retro-proposal parity); `reject` writes nothing else |
| `/metrics` | GET | S-12 — dashboard aggregates from `events`/`usage_calls`; includes `accepted_outcomes` + `cost_per_accepted_outcome` (wp-155, PRD §15.12: total inference+retry+execution+remediation spend over outcomes that reached `merged`/`released` — never per-call price; `null` when no outcome has landed) |
| `/scope-radar` | GET | wp-142 Scope Creep Radar (PRD §15.5): computed metrics — per baseline subject (doc drift vs pinned baseline, post-approval changesets, rework events, affected live runs, blast-radius cost) and per release (live items vs frozen v1 manifest: `scope_added`/`scope_removed`/`scope_change_pct`, manifest recuts). `?workspace=` required; `&subject=`/`&release=` scope to the ChangeSet decision view / Release Center header. Explainable — every number recomputed from rows/events, no cached score |
| `/scope-radar/<ws>/<changeset>/acknowledge` | POST | wp-142 — clears the changeset's open `scope-budget` escalation gate. Clearing IS the higher approval budget escalation demands (engine refuses approving decisions/apply while open). Writes `gate_items.cleared_at` + `gate_approved` event; 404 when nothing is open |
| `/gate-items/<id>/claim` `/release` | POST, DELETE | shared-queue claiming |
| `/gate-items/<ws>/<subject>/<gate>/snooze` | POST | D20 snooze — `{until}` ISO (or `{for_minutes}`) → `snoozed_until`; hidden from `/inbox` + badge until then (`?include_snoozed=1` reveals) |
| `/releases/<ws>` | GET, POST | DELIVERY §3 (wp-136). GET lists `releases` rows (`?status=` filter). POST `{title, target?}` → 201 draft `REL-NNNN` + `release_created`. 400 malformed |
| `/releases/<ws>/<rel>` | GET | Release detail (wp-136; wp-137 added `deployments` + `noteDrafts` — per-audience latest draft doc_version so a draft newer than the pinned approval renders as unapproved): `{release, items, manifests, manifest, approvals, approvalHistory, gates, notes, deployments, noteDrafts}` — approvals/gates bind to the latest manifest cut. 404 unknown release |
| `/releases/<ws>/<rel>/items` | POST, DELETE | Scope membership (wp-136). POST `{item_kind: feature\|ticket, item_id, partial_ac?, approved_by?}` — `partial_ac` REQUIRES `approved_by` (invariant 5); a post-freeze add/remove cuts a NEW `release_manifests` version and reverts `approved`→`ready` (§4.1). DELETE `{item_kind, item_id}` soft-removes (audit row stays). 400 bad item/partial-unapproved · 403 agent-approved partial · 404 unknown ticket/feature · 409 non-editable status |
| `/releases/<ws>/<rel>/freeze` | POST | Cut an immutable manifest + `draft→ready` (wp-136). Idempotent on unchanged digest. `expected_status` OCC → 409 stale. 400 empty scope |
| `/releases/<ws>/<rel>/approve` | POST | `{decision: approved\|rejected, rationale?, approver?, actor_kind?, expected_status?}` (wp-136) — human-only, binds the LATEST manifest digest; `rejected` → `draft`. `actor_kind: 'agent'` → **403** (invariant 6). OCC → 409 |
| `/releases/<ws>/<rel>/release` | POST | The ship write (wp-136 — §6 omits it; resolved gap, TRACKER D46): `approved→released`, evaluates all five release gates (`manifest, approved, merged, partial-ac, corrections`), appends `release_gate_results` audit, then flips member tickets `merged→released` transactionally. Any gate `fail` → **409**, release stays `approved`. `expected_status` OCC → 409 |
| `/releases/<ws>/<rel>/deployments` | POST | `{env, sha, evidence}` → 201 confirmed deployment + `deployment_confirmed` (wp-136). **Manual evidence required** (invariant 4): `evidence` must be `{type:'manual', by, note, url}`, all non-empty — `webhook`/`probe` are reserved slots, not accepted inputs. 400 invalid/absent evidence · 409 release not `released\|closed` |
| `/features/<ws>/<f>/exposure` | POST | `{env, state: hidden\|limited\|available, audience?, evidence?, deployment_id?}` (wp-136). `available` requires `deployment_id` linking a CONFIRMED deployment of a release carrying the feature to the same env (invariant 4, every clause fail-closed → 409). 404 unknown feature |
| `/merge-center/<ws>` | GET | Per-ticket merge readiness (wp-136): deterministic `evaluateMergeCenter` checklist per `ci-watch` ticket — `{ticket_id, ready, items[], blockers[], heads}` (approval/scope/ac-evidence/checks/security/depends-on/conflict/branch-protection/dod). Read-only; no merge execution over HTTP |
| `/tickets/<ws>/<t>/corrections` | POST | `{title, severity?, priority?, repos?, feature?, description?}` → 201 `origin:'correction'`, `work_type:'bug'` ticket with `parent:` the merged ticket + `correction_filed` on the parent (wp-136). 404 unknown parent · 409 parent not `merged\|released` |
| `/releases/<ws>/<rel>/notes/<audience>/approve` | POST | Human-only approval of the current `notes-<audience>.md` draft (`customer\|stakeholder\|technical`) — pins `doc_version` + `release_note_approved` (wp-136). `actor_kind:'agent'` → 403 · 409 no draft · 400 bad audience |
| `/releases/<ws>/<rel>/notes/<audience>/publish` | POST | `published_at` on an approved note (wp-136) — requires a human-approved `doc_version` (409 otherwise); the pinned approved revision is what ships, newer drafts don't launder in |
| `/releases/<ws>/<rel>/notes` | POST | Queue the `release-notes` stage run (wp-137 UI gap — the three-audience draft trigger). Requires a frozen manifest → 409 otherwise. `{run}` pending row |
| `/releases/<ws>/<rel>/notes/<audience>/draft` | POST | Human draft edit (wp-137): `{content, edited_by?}` appends `notes-<audience>.md` and upserts the `release_notes` row preserving the pinned approved `doc_version` — a re-draft never launders unapproved content. 400 empty/bad audience |
| `/releases/<ws>/<rel>/docs/<name>` | GET | Release-subject doc read (wp-137): `retro`/`retro.md` and `notes-<audience>` only — the Release Center renders drafts + the retrospective. Same payload as `/tickets/…/docs/<name>` (`{name, doc, content, version, versions, diffs}`). 400 other kinds · 404 absent |
| `/releases/<ws>/<rel>/retro` | POST | Queues a `retro` run on a `released\|closed` release (wp-136) → `{run}` pending row; a live run fences a duplicate → 409. 409 on a non-shipped release |

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
| `incident_status` | incident row or `{workspace, source_id, signatures, incidents_opened}` / `{workspace, incident, …}` | wp-120 — ingest/incident lifecycle/draft-proposal writes; durable truth is the `telemetry_ingested`/`incident_opened`/`incident_decided`/`draft_ticket_*` event rows + `incidents`/`incident_ticket_proposals` rows |
| `notification` | notification row | desktop toasts |
| `interview_updated` | `{workspace, session_id}` | wp-147 — Interview Orchestrator mutations (answer/mode/slot/statement writes); Understanding Panel + wizard surface refresh hint |
| `merge_ready` / `merge_attempted` / `merge_conflict` / `release_created` / `release_items_changed` / `manifest_cut` / `release_approved` / `release_released` / `deployment_confirmed` / `feature_exposed` / `release_note_approved` / `retro_completed` / `correction_filed` / `dependent_revalidated` | the appended `events` row | DELIVERY §5 (wp-136) — the durable delivery/merge lifecycle events mirrored onto the stream; Merge Center + Release Center live updates |

Every streamed fact is also written durably (`events` rows, other DB
rows, run_dir log files) — the stream is a latency optimization, never
the only copy; a reconnecting client re-reads state, no replay
protocol needed.
