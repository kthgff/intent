# DB SCHEMA — Veto storage contract

Companion to `SCHEMAS.md`. Revised 2026-10-04 (D29): **DB-only truth**.
One backend: **Postgres** (`postgres://…` via `storage_url`). SQLite is
removed; tests run the same impl against embedded Postgres (PGlite).
Vectors: pgvector where available, else `vector BLOB` bytea + app-side
cosine — same logical columns.

**The tickets repo is gone.** Git is source control for CODE only —
branches, worktrees, PRs, merged SHAs live in `ticket_repos`/`runs`.
Everything else — tickets, docs, events, boards, gates, ledger — is a
Postgres row. Nothing below is "rebuildable from git"; the DB IS the
system of record.

**Workspace keying**: `workspace` stays the internal key (D26) — it now
references `projects.workspace`. Ticket ids (`SR-NNNN`, tracker keys)
are unique per workspace only — every ticket-keyed table is
workspace-qualified so the unified inbox (S-01) queries across all of
them. **`subject`** = what a coordination object attaches to: a ticket
id, a feature/initiative ref, or `survey:<scope>:<name>` /
`probe:<repo>` / `import:<source>` / `interview:<run>` /
`synthesize:<board>` for non-ticket work.

**Hierarchy** (D26): `projects` → `boards` → `initiatives` → `features`
→ `tickets` (+orphan tickets with `feature: null`). `board_items` is
the Miro-style canvas layer — typed items positioned in space; an item
may *link* a ticket/feature/initiative (`ref`) or be a free note/zone/
feedback/retro card. `board: null` rows are the **capture tray** (D27).

```sql
-- --- meta ---
schema_meta(version INTEGER, applied_at TEXT);          -- target: 3 (D37)

-- --- projects (was tickets_repos — DB-only truth, D26/D29) ---
projects(
  workspace TEXT PRIMARY KEY,              -- internal key everywhere
  name TEXT,                               -- display name
  next_ticket_seq INT DEFAULT 1,           -- SR-NNNN allocator:
                                           -- UPDATE … SET next_ticket_seq =
                                           --   next_ticket_seq + 1
                                           --   RETURNING * (atomic)
  next_feature_seq INT DEFAULT 1,          -- F-NNNN
  next_initiative_seq INT DEFAULT 1,       -- I-NNNN
  next_release_seq INT DEFAULT 1,          -- REL-NNNN (DELIVERY §3)
  next_changeset_seq INT DEFAULT 1,        -- CS-NNNN (PRD §15.5, wp-140)
  settings TEXT,                           -- jsonb — per-project config
                                           -- overrides (SETTINGS
                                           -- precedence layer)
  created_at TEXT);

-- --- boards / canvas (D26 idea boards, D27 capture tray) ---
boards(
  workspace TEXT, board TEXT,              -- slug, unique per workspace
  name TEXT, created_at TEXT,
  PRIMARY KEY(workspace, board));
board_items(                               -- every card on a canvas;
  id TEXT PRIMARY KEY,                     -- board NULL = capture tray
  workspace TEXT NOT NULL,
  board TEXT,                              -- NULL → tray (D27)
  kind TEXT NOT NULL,                      -- idea|initiative|feature|
                                           -- ticket|note|zone|feedback|
                                           -- retro
  ref TEXT,                                -- linked subject when the
                                           -- card IS a tkt/feat/init
  title TEXT, body TEXT,
  x REAL, y REAL, w REAL, h REAL,          -- canvas geometry
  zone TEXT,                               -- zone membership
  serves TEXT,                             -- D33: goal board_item id(s)
                                           -- this item serves — canonical
                                           -- edge (connectors/zones are
                                           -- affordances writing it)
  status TEXT NOT NULL,                    -- icebox|active|consumed|
                                           -- frozen|shipped|discarded;
                                           -- goal items: active|achieved|
                                           -- abandoned (D33)
  consumed_by TEXT,                        -- synthesis ticket/run that
                                           -- consumed the card
  created_at TEXT, updated_at TEXT);

-- --- hierarchy (D26) ---
initiatives(
  workspace TEXT, initiative TEXT,         -- I-NNNN
  board TEXT,                              -- source board
  title TEXT, status TEXT,                 -- draft|planned|active|
                                           -- shipped|discarded
  owner TEXT, priority TEXT,
  serves TEXT,                             -- json array of goal
                                           -- board_item ids (D33)
  provenance TEXT,                         -- provenance.json (S-18)
  created_at TEXT, updated_at TEXT,
  PRIMARY KEY(workspace, initiative));
features(
  workspace TEXT, feature TEXT,            -- F-NNNN
  initiative TEXT,                         -- null = unparented
  title TEXT, status TEXT,                 -- draft|ready|active|done|
                                           -- discarded
  owner TEXT, priority TEXT,
  serves TEXT,                             -- json array — inherited
                                           -- from initiative (D33)
  created_at TEXT, updated_at TEXT,
  PRIMARY KEY(workspace, feature));

-- --- tickets (TRUTH — was a frontmatter projection) ---
tickets(
  workspace TEXT, ticket_id TEXT,
  feature TEXT,                            -- parent feature; null =
                                           -- orphan ticket
  title TEXT, status TEXT, priority TEXT, depth TEXT,
  backend TEXT, model TEXT, repos TEXT,    -- json array
  parent TEXT, depends_on TEXT,            -- json array (split/dep graph)
  serves TEXT,                             -- json array of goal
                                           -- board_item ids — inherited
                                           -- feature→initiative chain or
                                           -- direct override (D33)
  source TEXT,                             -- jira:…|github:…|manual|
                                           -- capture|synthesis
  forced INT DEFAULT 0,
  spec_score INT, spec_hash TEXT,          -- stale-spec check
  blocked_reason TEXT,                     -- env|agent|<text> when blocked
  created_at TEXT, updated_at TEXT,
  PRIMARY KEY(workspace, ticket_id));
ticket_repos(                              -- one row per repo a ticket
  workspace TEXT, ticket_id TEXT, repo TEXT, -- touches — git-for-CODE
  branch TEXT, worktree TEXT,              -- only (D29)
  pr_url TEXT, pr_state TEXT,              -- null|open|merged|closed
  ci_state TEXT,                           -- pending|green|failing
  merged_sha TEXT,
  PRIMARY KEY(workspace, ticket_id, repo));
-- Headline status is a rollup: `merged` iff EVERY ticket_repos row is
-- merged. Post-merge lifecycle (D27): merged → verifying → released
-- (verify_cmd → app_url smoke → verify-confirm human gate; failure →
-- verify_failed). `released` is terminal; `shipped` is a
-- feature/initiative-level rollup, never a ticket status.

-- --- docs (append-only versions — every persisted doc change = a
--     version; history + MR-style diffs, D24) ---
doc_versions(
  workspace TEXT, subject TEXT,            -- ticket_id | feature |
                                           -- initiative ref
  doc TEXT,                                -- ticket.md|prd.md|tdd.md|
                                           -- test.md|feature.md|ac.md|
                                           -- provenance.json|notes.md
  version INT,                             -- 1,2,3… per (subject, doc)
  content TEXT,                            -- full text — diffs derive
  edited_by TEXT,                          -- actor id (agent|human|…)
  created_at TEXT,
  PRIMARY KEY(workspace, subject, doc, version));
-- "Latest" = max(version) per (workspace, subject, doc). No current-doc
-- table — derive it; the version history is the truth.

-- --- events (append-only TRUTH — replaces events.jsonl + events_idx) ---
events(
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace TEXT, ticket_id TEXT,          -- ticket_id → subject in
  ts TEXT, stage TEXT,                     --   practice: may hold a
  actor_type TEXT, actor_id TEXT,          --   feature/init ref
  event TEXT, run TEXT, refs TEXT, data TEXT,  -- json
  cost_usd REAL, tokens_in INT, tokens_out INT, tokens_cached INT,
  usage_source TEXT, duration_s REAL, human_minutes REAL);
-- LOG.md is a derived render (API/UI), never stored.

-- --- coordination ---
leases(                                  -- fencing for stage runs
  workspace TEXT, subject TEXT, stage TEXT, attempt INT,
  holder TEXT,                           -- install/user id (actor:)
  acquired_at TEXT, ttl_s INT, heartbeat_at TEXT,
  PRIMARY KEY(workspace, subject, stage, attempt));
claims(                                  -- human-gate items; DB-only
  workspace TEXT, subject TEXT, gate TEXT,-- works across installs
  claimed_by TEXT, claimed_at TEXT, ttl_s INT,  -- sharing the Postgres
  PRIMARY KEY(workspace, subject, gate));  -- (multi-human gating is
                                         -- honest in team mode, D29)
runs(
  id TEXT PRIMARY KEY,                   -- e.g. ws/ABC-123/003-implement
  workspace TEXT, subject TEXT,
  ticket_id TEXT,                        -- null for non-ticket subjects
  stage TEXT, attempt INT,
  backend TEXT, model TEXT, depth TEXT,
  pid INT, worktree TEXT, status TEXT,
  container_id TEXT,                       -- docker id when runtime:
                                           -- container (D30); null for
                                           -- process runs
  request TEXT,                            -- json launch request for
                                           -- `pending` rows —
                                           -- {tokens, model}; survives
                                           -- the queue→claim relaunch
                                           -- (SEED_TEXT, CI_FAILURE_LOGS,
                                           -- PR_COMMENTS_JSON)
  started_at TEXT, heartbeat_at TEXT, exited_at TEXT,
  sentinel TEXT, sentinel_raw TEXT,
  cost_usd REAL,
  tokens_in INT, tokens_out INT, tokens_cached INT,
  usage_source TEXT,                      -- reported|partial|estimated
  duration_s REAL,
  run_dir TEXT);                         -- transcript/log dir only —
                                         -- structured artifacts live in
                                         -- run_artifacts (D29)
run_artifacts(                           -- structured runner output —
  run_id TEXT, name TEXT,                -- triage.json|review.json|
  content TEXT,                          -- usage.json|test-report.json|
  created_at TEXT,                       -- findings-*.json|sentinel|
  PRIMARY KEY(run_id, name));            -- pr-body.md|split-plan.md
containers(                              -- D30 per-subject ticket
  workspace TEXT, subject TEXT,          -- containers (aider runtime)
  container_id TEXT, image TEXT,
  state TEXT,                            -- created|running|stopped|
                                         -- removed
  created_at TEXT, stopped_at TEXT,
  PRIMARY KEY(workspace, subject));
presence(install_id TEXT PRIMARY KEY, actor TEXT, last_seen TEXT);
notifications(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace TEXT, subject TEXT,
  kind TEXT, payload TEXT, created_at TEXT, read_at TEXT);
usage_calls(                              -- per-call ledger
  run_id TEXT, seq INT, ts TEXT, model TEXT,
  tokens_in INT, tokens_out INT, tokens_cached INT,
  latency_s REAL, source TEXT,            -- reported|estimated
  PRIMARY KEY(run_id, seq));
gate_items(                              -- materialized inbox
  workspace TEXT, subject TEXT, gate TEXT,
  kind TEXT,                             -- question|approval|review|
                                         -- failure|escalation|
                                         -- split-plan|repair|verify
  surfaced_at TEXT, cleared_at TEXT,
  snoozed_until TEXT,                    -- D20: hidden from badge/inbox
  blocked_agent INT, priority TEXT,
  PRIMARY KEY(workspace, subject, gate));

-- --- knowledge base (unchanged shape) ---
dossiers(
  id TEXT,                               -- '<scope>:<name>:<section>'
  scope TEXT,                            -- repo | product
  name TEXT, section TEXT,
  version INT, content TEXT,
  surveyed_at TEXT, sources_used TEXT,
  stale INT DEFAULT 0,
  edited_by TEXT, edited_at TEXT,
  PRIMARY KEY(id, version));
entities(
  id TEXT PRIMARY KEY, product TEXT, kind TEXT,
  name TEXT, canonical TEXT, aliases TEXT,
  source TEXT, evidence TEXT);
relations(
  subject TEXT, predicate TEXT, object TEXT,
  evidence TEXT, source TEXT,                  -- explicit|human|model|tool
  confidence REAL,                            -- required for inferred links
  verification TEXT,                          -- suggested|auto-verified|
                                                -- verified|rejected
  valid_at TEXT,                              -- commit/version/time boundary
  PRIMARY KEY(subject, predicate, object));
embeddings(
  object_ref TEXT, model TEXT, vector BYTEA,
  PRIMARY KEY(object_ref, model));

-- --- evidence plane / code intelligence (D37) ---
repo_indexes(
  workspace TEXT, repo TEXT,
  commit_sha TEXT, status TEXT,                -- building|current|superseded|
                                                -- failed; partial never served
  parser_version TEXT, indexed_at TEXT,
  stats TEXT,                                  -- json: files/units/fallbacks
  PRIMARY KEY(workspace, repo, commit_sha));
code_units(
  id TEXT PRIMARY KEY,                         -- stable content-addressed ref
  workspace TEXT, repo TEXT, commit_sha TEXT,
  path TEXT, language TEXT,
  symbol TEXT, symbol_kind TEXT,
  start_line INT, end_line INT,
  content_hash TEXT, content TEXT,
  parse_status TEXT,                           -- parsed|fallback
  fts TSVECTOR,
  UNIQUE(workspace, repo, commit_sha, path, start_line, end_line));
code_edges(
  workspace TEXT, repo TEXT, commit_sha TEXT,
  subject_ref TEXT, predicate TEXT, object_ref TEXT,
  evidence TEXT, source TEXT, confidence REAL,
  PRIMARY KEY(workspace, repo, commit_sha,
              subject_ref, predicate, object_ref));
retrieval_evaluations(
  id TEXT PRIMARY KEY, suite_version TEXT, task TEXT,
  index_heads TEXT, metrics TEXT,              -- json; includes ACL violations
  created_at TEXT);

-- --- production intelligence (Phase C, D37) ---
telemetry_sources(
  id TEXT PRIMARY KEY, workspace TEXT,
  kind TEXT,                                   -- otlp|loki|opensearch|file|
                                                -- journald|docker
  config TEXT,                                 -- json; secret refs only
  redaction_policy TEXT, enabled INT,
  created_at TEXT, updated_at TEXT);
error_signatures(
  id TEXT PRIMARY KEY, workspace TEXT, source_id TEXT,
  fingerprint_version TEXT, fingerprint TEXT,
  normalized_pattern TEXT, representative TEXT, -- sanitized + bounded
  attributes TEXT,                             -- json: service/code/frames
  first_seen TEXT, last_seen TEXT, count BIGINT,
  raw_locator TEXT,                            -- backend query/ref, not raw log
  UNIQUE(workspace, source_id, fingerprint_version, fingerprint));
incidents(
  id TEXT PRIMARY KEY, workspace TEXT,
  signature_id TEXT, status TEXT,
  summary TEXT, investigation_ref TEXT,
  root_cause TEXT, resolution TEXT,
  resolution_verified INT DEFAULT 0,
  deployment_refs TEXT, ticket_refs TEXT, pr_refs TEXT,
  opened_at TEXT, resolved_at TEXT);

-- --- delivery / releases (DELIVERY §3, wp-131/133-135) ---
releases(workspace, org, release_id,      -- REL-NNNN (next_release_seq)
  title, status,                          -- draft|ready|approved|released|closed|abandoned
  target, created_by, created_at, updated_at,
  PRIMARY KEY(workspace, release_id));
release_items(workspace, org, release_id, item_kind,    -- feature|ticket
  item_id, partial_ac,                    -- json ac_ids; non-null ⇒ approved_by (inv.5)
  delivery_state,                         -- planned|released|deployed|exposed
  approved_by, added_by, added_at, removed_at,
  PRIMARY KEY(workspace, release_id, item_kind, item_id));
release_manifests(                        -- append-only (0002 trigger)
  workspace, org, release_id, version,    -- PK (ws, rel, version)
  digest,                                 -- sha256 of item→repo→sha map
  items,                                  -- json [{item_kind,item_id,repos:[{repo,merged_sha}]}]
  created_at);
release_approvals(                        -- append-only
  workspace, org, release_id, manifest_version,
  approver, decision,                     -- approved|rejected
  rationale, created_at,
  PRIMARY KEY(workspace, release_id, manifest_version, approver));
release_notes(workspace, org, release_id,
  audience,                               -- customer|stakeholder|technical
  doc_version,                            -- notes-<audience>.md revision
  approved_by, approved_at, published_at,
  PRIMARY KEY(workspace, release_id, audience));
release_gate_results(                     -- append-only audit
  id IDENTITY, workspace, org, release_id,
  gate, result,                           -- pass|fail|waived
  evidence, checked_at);                  -- json
deployments(
  workspace, org, deployment_id, release_id,
  environment,                            -- free-form (staging/prod/…)
  sha, evidence,                          -- json {type:manual|webhook|probe, by, note, url}
  confirmed_by, confirmed_at, created_at,
  PRIMARY KEY(workspace, deployment_id));
feature_exposure(
  workspace, org, feature_id, environment,
  state,                                  -- hidden|limited|available
  audience, evidence, deployment_id,      -- available ⇒ deployment_id (inv.4)
  updated_at,
  PRIMARY KEY(workspace, feature_id, environment));
release_outcomes(
  workspace, org, release_id, kpi,
  data,                                   -- json {baseline,target,observed,unit}
  measured_at,
  PRIMARY KEY(workspace, release_id, kpi));

-- --- changesets (PRD §15.5, wp-140) ---
changesets(workspace, org, changeset_id,    -- CS-NNNN (next_changeset_seq)
  title, request,                         -- verbatim request text
  baseline,                               -- json {subject,doc,version}
  classification,                         -- clarification|correction|addition|modification|removal
  status,                                 -- draft→…→verified (CHANGESET_STATUSES)
  analysis, decision,                     -- add-now|swap-scope|next-release|decline
  decision_rationale, decided_by, decided_at, expires_on,
  emergency, retro_ref, reconciliation,
  created_by, created_at, updated_at,
  PRIMARY KEY(workspace, changeset_id));
changeset_items(
  workspace, org, changeset_id, seq,      -- ordered apply list
  subject, doc, base_version, proposed_version,
  change,                                 -- json payload
  status, applied_at,                     -- pending|applied|skipped|failed
  PRIMARY KEY(workspace, changeset_id, seq));

-- --- statement ledger (PRD §15.3/§15.9, wp-143) ---
semantic_statements(                      -- head rows; history in statement_versions
  workspace, org, statement_id, version,
  text, source_text, source_ref,          -- verbatim source preserved (§15.3)
  intent, polarity, subject, strength, scope, scope_ref,
  status,                                 -- proposed|confirmed|disputed|superseded|rejected
  confidence, provenance,                 -- inferred|source-backed|stakeholder-verified
  extraction_run, created_by, created_at, updated_at,
  PRIMARY KEY(workspace, statement_id));
statement_versions(                       -- append-only (0002 trigger)
  workspace, org, statement_id, version, text, source_text,
  source_ref, intent, polarity, subject, strength, scope, scope_ref,
  status, confidence, provenance, extraction_run, edited_by, created_at,
  PRIMARY KEY(workspace, statement_id, version));
statement_relations(
  workspace, org, src, predicate,         -- supports|contradicts|clarifies|duplicates|depends-on|supersedes|derived-from
  dst, created_by, created_at,
  PRIMARY KEY(workspace, src, predicate, dst));
statement_clarifications(
  workspace, org, clarification_id, statement_id,
  question, answer, asked_by, answered_by, created_at, answered_at,
  PRIMARY KEY(workspace, clarification_id));
statement_decisions(
  workspace, org, decision_id, statement_id,
  decision, status,                       -- open|decided|dismissed
  rationale, decided_by, decided_at, created_by, created_at,
  PRIMARY KEY(workspace, decision_id));
statement_artifact_links(
  workspace, org, statement_id, artifact, -- 'subject:doc' or 'doc:<subj>:<doc>:v<N>'
  element,                                -- e.g. 'ac:AC-3'; '' = whole doc
  created_by, created_at,
  PRIMARY KEY(workspace, statement_id, artifact, element));
semantic_extraction_runs(
  workspace, org, extraction_run_id, run, subject,
  model, prompt_version, stats, created_at,
  PRIMARY KEY(workspace, extraction_run_id));

-- --- interview orchestrator (PRD §15.9, wp-145) ---
wizard_definitions(
  workspace, org, wizard_id, name, description,
  current_version, created_at, updated_at,
  PRIMARY KEY(workspace, wizard_id));
wizard_versions(                          -- append-only
  workspace, org, wizard_id, version,
  definition,                             -- json {slots,thresholds,prompts}
  created_at,
  PRIMARY KEY(workspace, wizard_id, version));
interview_sessions(
  workspace, org, session_id, wizard_id, wizard_version,
  subject, mode,                          -- conversation|guided|bulk
  status,                                 -- active|paused|completed|abandoned
  draft_ready, approval_ready,            -- two thresholds (§15.9)
  knowledge_version, created_by, created_at, updated_at,
  PRIMARY KEY(workspace, session_id));
interview_branches(
  workspace, org, session_id, branch, role,
  status, created_at, merged_at,          -- active|merged|abandoned
  PRIMARY KEY(workspace, session_id, branch));
interview_messages(                       -- append-only transcript
  workspace, org, session_id, seq,        -- per-session monotonic
  branch, role, content, created_at,      -- user|assistant|system
  PRIMARY KEY(workspace, session_id, seq));
knowledge_slots(
  workspace, org, session_id, slot,
  state,                                  -- known|inferred|missing|conflicted|not-applicable|deferred
  value, statement_refs,                  -- json statement_ids
  confidence, updated_at,
  PRIMARY KEY(workspace, session_id, slot));
question_candidates(
  workspace, org, session_id, question_id,
  slot, question, scores,                 -- json {impact,uncertainty,…}
  status,                                 -- proposed|asked|answered|skipped|unanswerable
  created_at, resolved_at,
  PRIMARY KEY(workspace, session_id, question_id));
session_snapshots(                        -- append-only resume points
  workspace, org, session_id, version,
  snapshot, reason, created_at,           -- json knowledge state
  PRIMARY KEY(workspace, session_id, version));

-- --- review studio (PRD §15.8, wp-148/149/150) ---
review_sessions(
  workspace, org, review_id, subject,
  status,                                 -- open|approved|changes-requested|closed
  created_by, created_at, closed_at,
  PRIMARY KEY(workspace, review_id));
review_revisions(                         -- append-only pinned heads
  workspace, org, review_id, revision,
  head_sha, base_sha, baseline,           -- json RunBaseline
  created_at,
  PRIMARY KEY(workspace, review_id, revision));
review_findings(
  workspace, org, finding_id, review_id, revision, subject,
  status,                                 -- open→…→resolved + terminal dispositions
  severity, category, kind,               -- spec-bug|code-bug
  thread_id, file, line, symbol, repo,
  body, evidence, suggested_fix, confidence, blocking,
  security_category, affected_asset, exposure, policy_violated,
  author, created_at, updated_at,
  PRIMARY KEY(workspace, finding_id));
review_comments(
  workspace, org, comment_id, review_id, revision, subject,
  file, line, type, disposition, ai_classification,
  body, author, changeset_id,             -- out-of-scope → ChangeSet
  created_at,
  PRIMARY KEY(workspace, comment_id));
review_decisions(                         -- append-only; binds head_sha+baseline
  workspace, org, decision_id, review_id, revision,
  reviewer, action,                       -- approve|comment|request-fix|request-changes|send-to-board
  head_sha, baseline, rationale, created_at,
  PRIMARY KEY(workspace, decision_id));
finding_resolutions(                      -- append-only lifecycle audit
  workspace, org, finding_id, seq,
  status, rationale, actor, created_at,
  PRIMARY KEY(workspace, finding_id, seq));
review_evidence_links(
  workspace, org, review_id, finding_id, evidence_ref, kind, created_at,
  PRIMARY KEY(workspace, review_id, finding_id, evidence_ref));
external_review_mappings(
  workspace, org, review_id, finding_id,
  external_kind, external_id, created_at,
  PRIMARY KEY(workspace, external_kind, external_id));
design_approvals(
  workspace, org, approval_id, subject,
  doc, doc_version,                       -- binds a mockup revision
  checklist, covers,                      -- json: gate results / AC ids
  reviewer, rationale, status,            -- approved|invalidated|superseded
  created_at, invalidated_at,
  PRIMARY KEY(workspace, approval_id));

-- --- process machinery (PRD §15.10, wp-153) ---
assumptions(
  workspace, org, assumption_id, subject,
  statement, impact, impact_if_false, evidence_needed, affected,
  status,                                 -- unverified|verified|invalidated|risk-accepted
  owner, source, created_at, updated_at, resolved_at,
  PRIMARY KEY(workspace, assumption_id));
quality_debt(
  workspace, org, debt_id, subject,
  kind,                                   -- accepted-risk|deferred-refactor|security-exception|weak-tests|doc-gap|other
  title, body, owner, revisit, expires_at,
  approved_by, approved_at, consolidated_into,
  status,                                 -- open|acknowledged|resolved|expired|consolidated
  created_at, updated_at,
  PRIMARY KEY(workspace, debt_id));
delivery_commitments(                     -- append-only versions
  workspace, org, commitment_id, version,
  scope,                                  -- json {features, requirement_versions}
  target, success_criteria, exclusions, assumptions,
  owner, status,                          -- planned|committed|implemented|verified|delivered|missed|cancelled
  created_by, created_at,
  PRIMARY KEY(workspace, commitment_id, version));

-- --- eval lab (PRD §15.12, wp-156) ---
eval_runs(
  workspace, org, eval_run_id, family,
  model, prompt_version, policy_version,
  status,                                 -- running|completed|failed
  metrics, created_by, created_at, completed_at,
  PRIMARY KEY(workspace, eval_run_id));
eval_cases(
  workspace, org, family, case_id,
  input, expected, tags, created_at,      -- json golden set
  PRIMARY KEY(workspace, family, case_id));
eval_results(                             -- append-only; re-run = new eval_run
  workspace, org, eval_run_id, family, case_id,
  verdict,                                -- pass|fail|skip
  scores, detail, created_at,
  PRIMARY KEY(workspace, eval_run_id, family, case_id));
```

## Rules

- **DB is the system of record** (D29). There is no git ledger, no
  ticket.md files on disk, no events.jsonl to replay. Backups = Postgres
  dumps. A fresh install starts from migrations, not a clone.
- **Id allocation** is transactional: `next_*_seq` counters on
  `projects` updated with `UPDATE … RETURNING` inside the insert's
  transaction — no ref-CAS, no races across installs.
- **Docs are immutable versions** (D24): writers append
  `doc_versions.version+1`; readers join on max(version). Human edits
  and agent drafts are the same mechanism — `edited_by` carries the
  actor. Diffs are computed at read time.
- **Events are append-only truth**: insert-only, never updated or
  deleted. `run_output` SSE streams from `run_dir` logs (follow-up —
  conductor does not yet emit log chunks).
- **run_artifacts** holds every structured artifact a stage produces
  (SCHEMAS §5/§6/§9/§10/§13 docs + sentinel payloads). `run_dir` keeps
  only transcripts/logs — blobs too big or too raw for rows.
- **Live usage**: `runs.tokens_*` update mid-run from adapter streams;
  `usage_calls` populated at run end (was usage.json — now the
  run_artifacts row of the same name, parsed into usage_calls).
- **Heartbeats are conductor-observed**: each reconcile tick records
  process liveness (host pid, or `docker inspect` + exec'd process for
  container runs) + artifact/log mtime into `runs.heartbeat_at` — the
  run never touches the DB. `stalled` after ~2 missed ticks; lease
  `ttl_s` default 300.
- **Containers** (D30): `containers` tracks the one persistent Docker
  container per subject (CONDUCTOR "Container lifecycle"); `state`
  mirrors `docker inspect`. The container is disposable — the mounted
  worktree holds all durable work. `runs.container_id` records which
  container executed the run.
- **Leases are DB-only**: `leases_via` is gone — no git-ref CAS exists.
- **Evidence indexes are derived, commit-pinned state** (D37): only a
  `repo_indexes.status = current` commit is the default retrieval head. A new
  index becomes current atomically after all changed paths are complete;
  `building`/`failed` rows are never served as current. Historical code units
  remain addressable for citations and audit.
- **Explicit and inferred links differ**: workflow/tool-written links use
  `verification = verified`; model links begin `suggested` with confidence and
  evidence. Confidence ≥0.90 may produce visibly labeled `auto-verified`;
  lower-confidence promotion requires a human. Promotion/rejection is an
  auditable event, never an overwrite of provenance.
- **Telemetry is not warehoused here** (D37): high-volume raw logs, traces,
  metrics, and counts stay in the configured observability backend. Veto stores
  sanitized/deduplicated signatures, backend locators, investigations, and
  verified resolutions. `config` stores secret names/refs only, never values.
- **Notifications**: generated on `gate_items` insert and on
  `run_failed`/`run_killed`/`blocked` events. Snoozed gate items
  (`snoozed_until > now`) stay open but are excluded from badge counts
  and inbox ranking (D20).
- **Dossier versioning**: refresh writes `version+1`, flags `stale`;
  humans' `edited_by` survives re-survey (conflict → human wins).
- **Retention**: `notifications`/`presence` pruned >30d; `run_dir`
  transcripts are filesystem data and age out on disk.
- **Actor identity**: every write carries the install/user id
  (SETTINGS `actor:`) — shared-queue attribution.
- **Design-for-both tenancy** (D43): every wp-131+ table carries
  `workspace` plus nullable `org`. Local-first leaves `org` NULL;
  a future SaaS pivot adds org scoping without a schema rewrite.
- **Append-only families are trigger-enforced** (0002): releases
  manifests/approvals/gate-results, statement_versions, wizard
  versions, interview transcript/snapshots, review
  revisions/decisions/resolutions, delivery_commitments versions,
  eval_results — UPDATE/DELETE raises at the DB layer, not just by
  interface discipline.
