-- 0001_init.sql — Postgres schema, mirrors docs/DB-SCHEMA.md (D29).
-- DB-only truth: tickets/docs/events/boards are truth rows. Git is code
-- source control only (ticket_repos / runs.worktree / merged_sha).

-- --- meta ---
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

-- --- projects (was tickets_repos — DB-only truth, D26/D29) ---
CREATE TABLE IF NOT EXISTS projects (
  workspace TEXT PRIMARY KEY,
  org TEXT,                                   -- D43 tenancy partition — reserved
                                              -- for the SaaS pivot, NULL local-first
  name TEXT,
  next_ticket_seq INTEGER NOT NULL DEFAULT 1,
  next_feature_seq INTEGER NOT NULL DEFAULT 1,
  next_initiative_seq INTEGER NOT NULL DEFAULT 1,
  next_release_seq INTEGER NOT NULL DEFAULT 1, -- REL-NNNN allocator (DELIVERY §3)
  settings TEXT,                              -- jsonb-serialized overrides
  created_at TEXT
);

-- --- boards / canvas ---
CREATE TABLE IF NOT EXISTS boards (
  workspace TEXT NOT NULL,
  org TEXT,                                   -- org-level boards keep unassigned
                                              -- ideas (§15.3); NULL local-first
  board TEXT NOT NULL,
  name TEXT,
  board_type TEXT,                            -- new-project|import|enhancement|
                                              -- modernization|quality|feedback|
                                              -- release-planning|exploration
                                              -- (§15.3 — config, not pipeline)
  status TEXT,                                -- draft|discovery|proposal-ready|
                                              -- approved|deferred|archived
  created_at TEXT,
  PRIMARY KEY (workspace, board)
);

CREATE TABLE IF NOT EXISTS board_items (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  org TEXT,
  board TEXT,                                 -- NULL = capture tray (D27)
  kind TEXT NOT NULL,
  ref TEXT,
  title TEXT,
  body TEXT,
  x REAL, y REAL, w REAL, h REAL,
  zone TEXT,
  serves TEXT,                                -- json array of goal board_item ids (D33)
  status TEXT NOT NULL,
  consumed_by TEXT,
  -- typed-sticky taxonomy (§15.3, wp-144) — layered on `kind`
  note_kind TEXT,                             -- idea|want|avoid|problem|
                                              -- constraint|question|decision|feedback
  topic TEXT,
  importance TEXT,                            -- must|should|nice|undecided
  applies_to TEXT,                            -- json array of refs the note
                                              -- applies to (tickets/features/…)
  note_status TEXT,                           -- open|deferred|resurfaced|
                                              -- resolved|dropped — "deferred
                                              -- ideas never die"
  rationale TEXT,
  provenance TEXT,                            -- inferred|source-backed|
                                              -- stakeholder-verified (wp-139)
  created_at TEXT,
  updated_at TEXT
);

-- --- hierarchy (D26) ---
CREATE TABLE IF NOT EXISTS initiatives (
  workspace TEXT NOT NULL,
  org TEXT,
  initiative TEXT NOT NULL,
  board TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  priority TEXT,
  serves TEXT,                                -- json array of goal board_item ids (D33)
  provenance TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, initiative)
);

CREATE TABLE IF NOT EXISTS features (
  workspace TEXT NOT NULL,
  org TEXT,
  feature TEXT NOT NULL,
  initiative TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  priority TEXT,
  serves TEXT,                                -- json array — inherited chain (D33)
  test_env TEXT,                              -- json declarative test-env spec
                                              -- (wp-157); tickets inherit unless
                                              -- overridden
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, feature)
);

-- --- tickets (TRUTH — was a frontmatter projection) ---
CREATE TABLE IF NOT EXISTS tickets (
  workspace TEXT NOT NULL,
  org TEXT,
  ticket_id TEXT NOT NULL,
  feature TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  depth TEXT,
  backend TEXT,
  model TEXT,
  repos TEXT NOT NULL,
  parent TEXT,
  depends_on TEXT NOT NULL,
  serves TEXT,                                -- json array of goal board_item ids (D33)
  source TEXT,
  -- §15.7 taxonomy (wp-151): work_type × origin are separate
  -- dimensions; severity only set on bugs/incidents (priority ≠
  -- severity). NULL = not yet classified.
  work_type TEXT,                             -- story|bug|technical|spike|
                                              -- security|infrastructure|data|
                                              -- documentation|quality
  origin TEXT,                                -- rs|board|review|incident|
                                              -- ai-finding|correction|manual
  severity TEXT,                              -- blocker|critical|major|minor|trivial
  -- DoR/decomposition verdicts (wp-153/154) — every ticket carries a
  -- verdict slot; defaults mean "not yet assessed".
  execution_readiness TEXT NOT NULL DEFAULT 'unassessed', -- unassessed|
                                              -- incomplete|ready|blocked
  parallel_safety TEXT NOT NULL DEFAULT 'unknown',        -- unknown|safe|
                                              -- caution|exclusive
  source_ref TEXT,                            -- json {system,url,imported_at,
                                              -- original_status} — import
                                              -- provenance (wp-139)
  test_env TEXT,                              -- json declarative test-env spec
                                              -- (wp-157); inherits feature's
  forced INTEGER NOT NULL DEFAULT 0,
  spec_score INTEGER,
  spec_hash TEXT,
  blocked_reason TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, ticket_id)
);

CREATE TABLE IF NOT EXISTS ticket_repos (
  workspace TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT,
  worktree TEXT,
  pr_url TEXT,
  pr_state TEXT,
  ci_state TEXT,
  merged_sha TEXT,
  PRIMARY KEY (workspace, ticket_id, repo)
);

-- --- docs (append-only versions) ---
CREATE TABLE IF NOT EXISTS doc_versions (
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  edited_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, subject, doc, version)
);

-- --- events (append-only TRUTH) ---
CREATE TABLE IF NOT EXISTS events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace TEXT NOT NULL,
  ticket_id TEXT,
  ts TEXT NOT NULL,
  stage TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event TEXT NOT NULL,
  run TEXT,
  refs TEXT,
  data TEXT,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  usage_source TEXT,
  duration_s REAL,
  human_minutes REAL
);

-- --- coordination ---
CREATE TABLE IF NOT EXISTS leases (
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  ttl_s INTEGER NOT NULL,
  heartbeat_at TEXT,
  PRIMARY KEY (workspace, subject, stage, attempt)
);

CREATE TABLE IF NOT EXISTS claims (
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  gate TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  ttl_s INTEGER NOT NULL,
  PRIMARY KEY (workspace, subject, gate)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  ticket_id TEXT,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  backend TEXT,
  model TEXT,
  depth TEXT,
  pid INTEGER,
  worktree TEXT,
  container_id TEXT,                          -- docker id, runtime:container (D30)
  request TEXT,                               -- json pending-run request
                                              -- {tokens, model, task} (D29)
                                              -- + baseline {rs_version,
                                              -- ticket_rev, design_rev,
                                              -- ac_ids, base_sha,
                                              -- contract_ver} — the pinned
                                              -- spec baseline (PRD §15.5,
                                              -- wp-141); shape lives in
                                              -- RunBaselineSchema, no DDL
                                              -- column
  status TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  exited_at TEXT,
  sentinel TEXT,
  sentinel_raw TEXT,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  usage_source TEXT,
  duration_s REAL,
  run_dir TEXT
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS containers (
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  container_id TEXT NOT NULL,
  image TEXT,
  state TEXT NOT NULL,                        -- created|running|stopped|removed
  created_at TEXT,
  stopped_at TEXT,
  PRIMARY KEY (workspace, subject)
);

CREATE TABLE IF NOT EXISTS presence (
  install_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_calls (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  latency_s REAL,
  source TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS gate_items (
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  gate TEXT NOT NULL,
  kind TEXT NOT NULL,
  surfaced_at TEXT NOT NULL,
  cleared_at TEXT,
  snoozed_until TEXT,
  blocked_agent INTEGER,
  priority TEXT,
  PRIMARY KEY (workspace, subject, gate)
);

-- --- knowledge base ---
CREATE TABLE IF NOT EXISTS dossiers (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  section TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  surveyed_at TEXT NOT NULL,
  sources_used TEXT,
  stale INTEGER DEFAULT 0,
  edited_by TEXT,
  edited_at TEXT,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical TEXT NOT NULL,
  aliases TEXT,
  source TEXT NOT NULL,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS relations (
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  evidence TEXT,
  source TEXT,
  PRIMARY KEY (subject, predicate, object)
);

CREATE TABLE IF NOT EXISTS embeddings (
  object_ref TEXT NOT NULL,
  model TEXT NOT NULL,
  vector BYTEA,
  PRIMARY KEY (object_ref, model)
);

-- --- evidence plane / code intelligence (D37) ---
CREATE TABLE IF NOT EXISTS repo_indexes (
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  parser_version TEXT,
  indexed_at TEXT,
  stats TEXT,
  PRIMARY KEY (workspace, repo, commit_sha)
);

CREATE TABLE IF NOT EXISTS code_units (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  path TEXT,
  language TEXT,
  symbol TEXT,
  symbol_kind TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT,
  content TEXT,
  parse_status TEXT,
  fts TSVECTOR,
  UNIQUE (workspace, repo, commit_sha, path, start_line, end_line)
);

CREATE TABLE IF NOT EXISTS code_edges (
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  evidence TEXT,
  source TEXT,
  confidence REAL,
  PRIMARY KEY (workspace, repo, commit_sha, subject_ref, predicate, object_ref)
);

CREATE TABLE IF NOT EXISTS retrieval_evaluations (
  id TEXT PRIMARY KEY,
  suite_version TEXT,
  task TEXT,
  index_heads TEXT,
  metrics TEXT,
  created_at TEXT
);

-- --- production intelligence (Phase C, D37) ---
CREATE TABLE IF NOT EXISTS telemetry_sources (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT,                                -- json; secret refs only
  redaction_policy TEXT,
  enabled INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS error_signatures (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  source_id TEXT,
  fingerprint_version TEXT,
  fingerprint TEXT,
  normalized_pattern TEXT,
  representative TEXT,
  attributes TEXT,
  first_seen TEXT,
  last_seen TEXT,
  count BIGINT,
  raw_locator TEXT,
  UNIQUE (workspace, source_id, fingerprint_version, fingerprint)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  signature_id TEXT,
  status TEXT,
  summary TEXT,
  investigation_ref TEXT,
  root_cause TEXT,
  resolution TEXT,
  resolution_verified INTEGER DEFAULT 0,
  deployment_refs TEXT,
  ticket_refs TEXT,
  pr_refs TEXT,
  opened_at TEXT,
  resolved_at TEXT
);

-- =====================================================================
-- Addendum tables (wp-131 freeze — PRD §15 / DELIVERY §3).
-- Every new table carries `workspace TEXT NOT NULL` + `org TEXT`
-- (nullable; design-for-both tenancy, D43 — a SaaS pivot needs no
-- schema rewrite). Append-only tables are enforced by triggers in
-- 0002_relations_append_only.sql.
-- =====================================================================

-- --- releases / delivery (DELIVERY §3) ---
CREATE TABLE IF NOT EXISTS releases (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,                   -- REL-NNNN (projects.next_release_seq)
  title TEXT NOT NULL,
  status TEXT NOT NULL,                       -- draft|ready|approved|released|
                                              -- closed|abandoned
  target TEXT,                                -- free-text version/train/date
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, release_id)
);

CREATE TABLE IF NOT EXISTS release_items (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,                    -- feature|ticket
  item_id TEXT NOT NULL,
  partial_ac TEXT,                            -- json ac_ids; NULL = full item —
                                              -- non-null requires approved_by
                                              -- (DELIVERY invariant 5)
  delivery_state TEXT NOT NULL DEFAULT 'planned', -- planned|released|deployed|
                                              -- exposed (DELIVERY §1 —
                                              -- materialized dimension)
  approved_by TEXT,
  added_by TEXT,
  added_at TEXT,
  removed_at TEXT,
  PRIMARY KEY (workspace, release_id, item_kind, item_id)
);

CREATE TABLE IF NOT EXISTS release_manifests (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,                       -- sha256 of the item→repo→sha map
  items TEXT NOT NULL,                        -- json [{item_kind,item_id,repos:
                                              -- [{repo,merged_sha}]}]
  created_at TEXT,
  PRIMARY KEY (workspace, release_id, version)
);
-- Immutable: a scope change cuts a new version and resets pending
-- approvals (DELIVERY invariant 3). UPDATE/DELETE rejected by trigger.

CREATE TABLE IF NOT EXISTS release_approvals (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,                     -- approved|rejected
  rationale TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, release_id, manifest_version, approver)
);
-- Append-only audit — approval binds to the manifest digest.

CREATE TABLE IF NOT EXISTS release_notes (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  audience TEXT NOT NULL,                     -- customer|stakeholder|technical
  doc_version INTEGER,                        -- doc_versions version of the
                                              -- notes-<audience>.md content
  approved_by TEXT,
  approved_at TEXT,
  published_at TEXT,
  PRIMARY KEY (workspace, release_id, audience)
);
-- Note CONTENT lives in doc_versions (notes-<audience>.md); this row is
-- the publication metadata (DELIVERY §3 "not separate tables").

CREATE TABLE IF NOT EXISTS release_gate_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  result TEXT NOT NULL,                       -- pass|fail|waived — a waiver
                                              -- is recorded in evidence
  evidence TEXT,                              -- json
  checked_at TEXT NOT NULL
);
-- Append-only readiness-gate audit (DELIVERY §3).

CREATE TABLE IF NOT EXISTS deployments (
  workspace TEXT NOT NULL,
  org TEXT,
  deployment_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,                  -- free-form env name (staging,
                                              -- prod, …) — envs are config,
                                              -- not a fixed enum
  sha TEXT NOT NULL,
  evidence TEXT NOT NULL,                     -- json {type:manual|webhook|
                                              -- probe, by, note, url} —
                                              -- non-empty evidence required
                                              -- (DELIVERY invariant 4);
                                              -- MVP manual-only
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, deployment_id)
);

CREATE TABLE IF NOT EXISTS feature_exposure (
  workspace TEXT NOT NULL,
  org TEXT,
  feature_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  state TEXT NOT NULL,                        -- hidden|limited|available —
                                              -- `available` requires a linked
                                              -- deployment (invariant 4)
  audience TEXT,
  evidence TEXT,
  deployment_id TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, feature_id, environment)
);

CREATE TABLE IF NOT EXISTS release_outcomes (
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  kpi TEXT NOT NULL,                          -- metric name (row identity);
                                              -- DELIVERY §3's "kpi json" splits
                                              -- into name + data so a release
                                              -- can carry several KPIs
  data TEXT,                                  -- json {baseline,target,
                                              -- observed,unit}
  measured_at TEXT,
  PRIMARY KEY (workspace, release_id, kpi)
);

-- --- changesets (PRD §15.5, wp-140) ---
CREATE TABLE IF NOT EXISTS changesets (
  workspace TEXT NOT NULL,
  org TEXT,
  changeset_id TEXT NOT NULL,
  title TEXT,
  request TEXT NOT NULL,                      -- the original change request,
                                              -- verbatim
  baseline TEXT,                              -- json {subject,doc,version} —
                                              -- the pin the change applies to
  classification TEXT,                        -- clarification|correction|
                                              -- addition|modification|removal
  status TEXT NOT NULL,                       -- draft|analyzing|awaiting-
                                              -- decision|approved|deferred|
                                              -- rejected|applying|apply-failed|
                                              -- verified|abandoned
  analysis TEXT,                              -- json affected-artifact
                                              -- analysis (relations +
                                              -- statements, wp-143)
  decision TEXT,                              -- add-now|swap-scope|
                                              -- next-release|decline
  decision_rationale TEXT,
  decided_by TEXT,
  decided_at TEXT,
  expires_on TEXT,                            -- approval expiry — material
                                              -- upstream change revalidates
                                              -- only what's invalidated
  emergency INTEGER NOT NULL DEFAULT 0,       -- expedited route — retro doc
                                              -- mandatory (retro_ref)
  retro_ref TEXT,                             -- doc_version ref of the retro
  reconciliation TEXT,                        -- json apply/reconcile rollup —
                                              -- partial application stays
                                              -- visible
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, changeset_id)
);

CREATE TABLE IF NOT EXISTS changeset_items (
  workspace TEXT NOT NULL,
  org TEXT,
  changeset_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                       -- caller-assigned ordinal —
                                              -- items are an ordered apply list
  subject TEXT NOT NULL,                      -- affected artifact subject
  doc TEXT,                                   -- doc kind when doc-addressable
  base_version INTEGER,
  proposed_version INTEGER,                   -- doc_version carrying the
                                              -- proposed diff (never in-place)
  change TEXT,                                -- json proposed-change payload
  status TEXT NOT NULL DEFAULT 'pending',     -- pending|applied|skipped|failed
  applied_at TEXT,
  PRIMARY KEY (workspace, changeset_id, seq)
);

-- --- statement ledger (PRD §15.3/§15.9, wp-143) ---
CREATE TABLE IF NOT EXISTS semantic_statements (
  workspace TEXT NOT NULL,
  org TEXT,
  statement_id TEXT NOT NULL,
  version INTEGER NOT NULL,                   -- head: mirrors
                                              -- max(statement_versions.version)
  text TEXT NOT NULL,                         -- the atomic assertion
                                              -- (normalized wording)
  source_text TEXT,                           -- verbatim source — never
                                              -- paraphrased away
  source_ref TEXT,                            -- json {kind,id,span} — where the
                                              -- words came from
  intent TEXT,                                -- want|avoid|prohibits|requires|
                                              -- constraint|assumption|decision|
                                              -- question|problem|observation
  polarity TEXT,                              -- affirm|negate (negations must
                                              -- survive extraction)
  subject TEXT,                               -- topic/subject text
  strength TEXT,                              -- must|should|nice|undecided
  scope TEXT,                                 -- org|solution|initiative|
                                              -- feature|repo|ticket|board
  scope_ref TEXT,                             -- entity the scope pins to
  status TEXT NOT NULL,                       -- proposed|confirmed|disputed|
                                              -- superseded|rejected
  confidence REAL,
  provenance TEXT,                            -- inferred|source-backed|
                                              -- stakeholder-verified
  extraction_run TEXT,                        -- semantic_extraction_runs id
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, statement_id)
);

CREATE TABLE IF NOT EXISTS statement_versions (
  workspace TEXT NOT NULL,
  org TEXT,
  statement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_text TEXT,
  source_ref TEXT,
  intent TEXT,
  polarity TEXT,
  subject TEXT,
  strength TEXT,
  scope TEXT,
  scope_ref TEXT,
  status TEXT NOT NULL,
  confidence REAL,
  provenance TEXT,
  extraction_run TEXT,
  edited_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, statement_id, version)
);
-- Append-only history — one row per written version (doc_versions
-- discipline; trigger-enforced).

CREATE TABLE IF NOT EXISTS statement_relations (
  workspace TEXT NOT NULL,
  org TEXT,
  src TEXT NOT NULL,                          -- statement_id
  predicate TEXT NOT NULL,                    -- supports|contradicts|clarifies|
                                              -- duplicates|depends-on|
                                              -- supersedes|derived-from
  dst TEXT NOT NULL,                          -- statement_id
  created_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, src, predicate, dst)
);
-- Typed statement edges — the authority rule resolves on these, not on
-- vector similarity (§15.3).

CREATE TABLE IF NOT EXISTS statement_clarifications (
  workspace TEXT NOT NULL,
  org TEXT,
  clarification_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  asked_by TEXT,
  answered_by TEXT,
  created_at TEXT,
  answered_at TEXT,
  PRIMARY KEY (workspace, clarification_id)
);

CREATE TABLE IF NOT EXISTS statement_decisions (
  workspace TEXT NOT NULL,
  org TEXT,
  decision_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  decision TEXT,                              -- the human ruling (free text)
  status TEXT NOT NULL,                       -- open|decided|dismissed
  rationale TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, decision_id)
);
-- Disagreements/consequential interpretations become decision items —
-- never a silent merge (§15.9).

CREATE TABLE IF NOT EXISTS statement_artifact_links (
  workspace TEXT NOT NULL,
  org TEXT,
  statement_id TEXT NOT NULL,
  artifact TEXT NOT NULL,                     -- subject:doc or
                                              -- doc:<subject>:<doc>:v<N>
  element TEXT NOT NULL DEFAULT '',           -- element inside the artifact
                                              -- (e.g. ac:AC-3); '' = whole doc
  created_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, statement_id, artifact, element)
);
-- Statement → generated-artifact back-links (wp-146's
-- unsupported-binding-requirement lint reads these).

CREATE TABLE IF NOT EXISTS semantic_extraction_runs (
  workspace TEXT NOT NULL,
  org TEXT,
  extraction_run_id TEXT NOT NULL,
  run TEXT,                                   -- runs.id that produced it
  subject TEXT,                               -- board/session/subject ref
  model TEXT,
  prompt_version TEXT,
  stats TEXT,                                 -- json
  created_at TEXT,
  PRIMARY KEY (workspace, extraction_run_id)
);
-- Extraction provenance — model + prompt version per batch (wp-143).

-- --- interview orchestrator (PRD §15.9, wp-145) ---
CREATE TABLE IF NOT EXISTS wizard_definitions (
  workspace TEXT NOT NULL,
  org TEXT,
  wizard_id TEXT NOT NULL,                    -- e.g. solution-discovery
  name TEXT,
  description TEXT,
  current_version INTEGER,                    -- live wizard_versions.version
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, wizard_id)
);

CREATE TABLE IF NOT EXISTS wizard_versions (
  workspace TEXT NOT NULL,
  org TEXT,
  wizard_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,                   -- json {slots:[{slot,required,
                                              -- scope}], thresholds, prompts}
  created_at TEXT,
  PRIMARY KEY (workspace, wizard_id, version)
);
-- Versioned wizard config (§15.9) — append-only.

CREATE TABLE IF NOT EXISTS interview_sessions (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  wizard_id TEXT,
  wizard_version INTEGER,
  subject TEXT,                               -- what the session serves
                                              -- (solution/feature/release ref)
  mode TEXT,                                  -- conversation|guided|bulk —
                                              -- switchable without loss
  status TEXT NOT NULL,                       -- active|paused|completed|
                                              -- abandoned
  draft_ready INTEGER NOT NULL DEFAULT 0,     -- draft-ready ≠ approval-ready:
  approval_ready INTEGER NOT NULL DEFAULT 0,  -- two thresholds (§15.9)
  knowledge_version INTEGER,                  -- last snapshotted knowledge
                                              -- version — drives the resume
                                              -- diff briefing (briefing.json)
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, session_id)
);

CREATE TABLE IF NOT EXISTS interview_branches (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  role TEXT,                                  -- stakeholder role routed here
  status TEXT NOT NULL,                       -- active|merged|abandoned
  created_at TEXT,
  merged_at TEXT,
  PRIMARY KEY (workspace, session_id, branch)
);
-- Multi-stakeholder specialist branches merge statements preserving
-- attribution (§15.9).

CREATE TABLE IF NOT EXISTS interview_messages (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                       -- per-session monotonic —
                                              -- store-assigned on append
  branch TEXT,                                -- branch provenance survives
                                              -- the merge
  role TEXT NOT NULL,                         -- user|assistant|system
  content TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (workspace, session_id, seq)
);
-- Durable transcript — the stream is never the only copy (§15.9).
-- Append-only, trigger-enforced.

CREATE TABLE IF NOT EXISTS knowledge_slots (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  slot TEXT NOT NULL,                         -- slot name from the wizard
                                              -- definition's knowledge areas
  state TEXT NOT NULL,                        -- known|inferred|missing|
                                              -- conflicted|not-applicable|
                                              -- deferred
  value TEXT,                                 -- current best-answer summary
  statement_refs TEXT,                        -- json array of statement_ids
  confidence REAL,
  updated_at TEXT,
  PRIMARY KEY (workspace, session_id, slot)
);

CREATE TABLE IF NOT EXISTS question_candidates (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  slot TEXT,                                  -- target knowledge slot
  question TEXT NOT NULL,
  scores TEXT,                                -- json {impact,uncertainty,
                                              -- relevance,answerability,effort}
  status TEXT NOT NULL,                       -- proposed|asked|answered|
                                              -- skipped|unanswerable — never
                                              -- re-ask the unanswerable
  created_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (workspace, session_id, question_id)
);

CREATE TABLE IF NOT EXISTS session_snapshots (
  workspace TEXT NOT NULL,
  org TEXT,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,                     -- json knowledge state + position
  reason TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, session_id, version)
);
-- Resumable-session snapshots (§15.9) — append-only.

-- --- review studio (PRD §15.8, wp-148/149/150) ---
CREATE TABLE IF NOT EXISTS review_sessions (
  workspace TEXT NOT NULL,
  org TEXT,
  review_id TEXT NOT NULL,
  subject TEXT NOT NULL,                      -- ticket (or subject) under review
  status TEXT NOT NULL,                       -- open|approved|
                                              -- changes-requested|closed
  created_by TEXT,
  created_at TEXT,
  closed_at TEXT,
  PRIMARY KEY (workspace, review_id)
);

CREATE TABLE IF NOT EXISTS review_revisions (
  workspace TEXT NOT NULL,
  org TEXT,
  review_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  head_sha TEXT NOT NULL,                     -- the reviewable head —
                                              -- approvals bind to it + the
                                              -- spec baseline (stale-approval)
  base_sha TEXT,
  baseline TEXT,                              -- json RunBaseline shape pinned
                                              -- at review time
  created_at TEXT,
  PRIMARY KEY (workspace, review_id, revision)
);

CREATE TABLE IF NOT EXISTS review_findings (
  workspace TEXT NOT NULL,
  org TEXT,
  finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  revision INTEGER,                           -- revision first seen on
  subject TEXT,
  status TEXT NOT NULL,                       -- open|triaged|in-remediation|
                                              -- ready-for-verification|
                                              -- resolved|accepted-risk|
                                              -- not-applicable|duplicate|
                                              -- deferred-with-approval
  severity TEXT,                              -- blocker|major|minor|nit|question
  category TEXT,                              -- correctness|security|perf|
                                              -- style|test-gap|spec-deviation
  kind TEXT,                                  -- spec-bug|code-bug
  thread_id TEXT,                             -- link back to the review.json
                                              -- thread
  file TEXT,
  line INTEGER,
  symbol TEXT,
  repo TEXT,
  body TEXT NOT NULL,
  evidence TEXT,
  suggested_fix TEXT,
  confidence REAL,
  blocking INTEGER NOT NULL DEFAULT 0,        -- human-marked blocking — AI may
                                              -- propose resolution, never
                                              -- self-resolves (§15.8)
  security_category TEXT,                     -- access-control|injection|
                                              -- secrets|data-exposure|
                                              -- unsafe-deps|prompt-injection|
                                              -- insecure-defaults (wp-150)
  affected_asset TEXT,
  exposure TEXT,
  policy_violated TEXT,
  author TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, finding_id)
);

CREATE TABLE IF NOT EXISTS review_comments (
  workspace TEXT NOT NULL,
  org TEXT,
  comment_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  revision INTEGER,
  subject TEXT,
  file TEXT,
  line INTEGER,
  type TEXT,                                  -- defect|requirement-gap|
                                              -- security|architecture|
                                              -- improvement|question|
                                              -- preference|out-of-scope|praise
  disposition TEXT,                           -- must-fix|suggestion|question|
                                              -- informational
  ai_classification TEXT,                     -- json AI-proposed
                                              -- {type,disposition} before
                                              -- human confirmation
  body TEXT NOT NULL,
  author TEXT,
  changeset_id TEXT,                          -- the ChangeSet an out-of-scope
                                              -- comment routed to (wp-140)
  created_at TEXT,
  PRIMARY KEY (workspace, comment_id)
);
-- Semantic comments: a comment is an instruction, not authorization —
-- `out-of-scope` routes to change control (§15.8).

CREATE TABLE IF NOT EXISTS review_decisions (
  workspace TEXT NOT NULL,
  org TEXT,
  decision_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  revision INTEGER,
  reviewer TEXT NOT NULL,
  action TEXT NOT NULL,                       -- approve|comment|request-fix|
                                              -- request-changes|send-to-board
  head_sha TEXT NOT NULL,                     -- decisions bind to head SHA +
  baseline TEXT,                              -- json spec baseline — post-
                                              -- approval code change → stale
  rationale TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, decision_id)
);
-- Append-only verdicts; internal approvals never pose as GitHub
-- approvals (§15.8).

CREATE TABLE IF NOT EXISTS finding_resolutions (
  workspace TEXT NOT NULL,
  org TEXT,
  finding_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,                       -- review_findings status value
  rationale TEXT,                             -- required on terminal
                                              -- dispositions (§15.8)
  actor TEXT NOT NULL,                        -- permissioned actor
  created_at TEXT,
  PRIMARY KEY (workspace, finding_id, seq)
);
-- Append-only finding lifecycle audit.

CREATE TABLE IF NOT EXISTS review_evidence_links (
  workspace TEXT NOT NULL,
  org TEXT,
  review_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,                 -- ev_…|doc:<subj>:<doc>:v<N>|
                                              -- run:<id>:<name>|ac:<id>
  kind TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, review_id, finding_id, evidence_ref)
);
-- Requirement-first review: finding → evidence edges (AC →
-- implementing code → test evidence, §15.8).

CREATE TABLE IF NOT EXISTS external_review_mappings (
  workspace TEXT NOT NULL,
  org TEXT,
  review_id TEXT NOT NULL,
  finding_id TEXT,
  external_kind TEXT NOT NULL,                -- github-pr-review|github-comment
  external_id TEXT NOT NULL,                  -- platform-side id
  created_at TEXT,
  PRIMARY KEY (workspace, external_kind, external_id)
);
-- Explicit, idempotent finding↔external-thread mapping — GitHub stays
-- authoritative for PR state (§15.8).

CREATE TABLE IF NOT EXISTS design_approvals (
  workspace TEXT NOT NULL,
  org TEXT,
  approval_id TEXT NOT NULL,
  subject TEXT NOT NULL,                      -- feature/ticket the approved
                                              -- design belongs to
  doc TEXT NOT NULL,                          -- mockup.json doc kind
  doc_version INTEGER NOT NULL,               -- the approved revision —
                                              -- a material component change
                                              -- invalidates only affected
                                              -- approvals (§15.4)
  checklist TEXT,                             -- json {desktop,mobile,flows,
                                              -- error-empty,a11y,…}
  covers TEXT,                                -- json array of requirement/ac
                                              -- ids this approval covers
  reviewer TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,                       -- approved|invalidated|superseded
  created_at TEXT,
  invalidated_at TEXT,
  PRIMARY KEY (workspace, approval_id)
);

-- --- process machinery (PRD §15.10, wp-153) ---
CREATE TABLE IF NOT EXISTS assumptions (
  workspace TEXT NOT NULL,
  org TEXT,
  assumption_id TEXT NOT NULL,
  subject TEXT,
  statement TEXT NOT NULL,                    -- the unverified statement
                                              -- being relied on
  impact TEXT,                                -- high|medium|low
  impact_if_false TEXT,
  evidence_needed TEXT,
  affected TEXT,                              -- json array of affected
                                              -- artifact refs
  status TEXT NOT NULL,                       -- unverified|verified|
                                              -- invalidated|risk-accepted
  owner TEXT,
  source TEXT,                                -- run/stage that captured it
  created_at TEXT,
  updated_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (workspace, assumption_id)
);
-- Assumption Register: auto-captured when a stage depends on unverified
-- info; high-impact unverified rows gate or get human risk-acceptance.

CREATE TABLE IF NOT EXISTS quality_debt (
  workspace TEXT NOT NULL,
  org TEXT,
  debt_id TEXT NOT NULL,
  subject TEXT,
  kind TEXT NOT NULL,                         -- accepted-risk|deferred-
                                              -- refactor|security-exception|
                                              -- weak-tests|doc-gap|other
  title TEXT NOT NULL,
  body TEXT,
  owner TEXT,                                 -- owned, never anonymous
  revisit TEXT,                               -- when/what triggers a revisit
  expires_at TEXT,                            -- security exceptions expire
                                              -- loudly (wp-153)
  approved_by TEXT,
  approved_at TEXT,
  consolidated_into TEXT,                     -- modernization initiative/item
                                              -- this consolidated into
  status TEXT NOT NULL,                       -- open|acknowledged|resolved|
                                              -- expired|consolidated
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, debt_id)
);
-- Quality Debt Register (§15.10).

CREATE TABLE IF NOT EXISTS delivery_commitments (
  workspace TEXT NOT NULL,
  org TEXT,
  commitment_id TEXT NOT NULL,
  version INTEGER NOT NULL,                   -- head = max(version)
  scope TEXT NOT NULL,                        -- json {features:[],
                                              -- requirement_versions:{…}}
  target TEXT,                                -- target release/date
  success_criteria TEXT,
  exclusions TEXT,
  assumptions TEXT,
  owner TEXT,                                 -- accountable owner (D43)
  status TEXT NOT NULL,                       -- planned|committed|implemented|
                                              -- verified|delivered|missed|
                                              -- cancelled
  created_by TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, commitment_id, version)
);
-- Versioned committed scope (§15.6): planned ≠ committed ≠ implemented
-- ≠ verified ≠ delivered. Append-only per version (trigger-enforced).

-- --- eval lab (PRD §15.12, wp-156) ---
CREATE TABLE IF NOT EXISTS eval_runs (
  workspace TEXT NOT NULL,
  org TEXT,
  eval_run_id TEXT NOT NULL,
  family TEXT NOT NULL,                       -- extraction|questions|rs-draft|
                                              -- review|coverage|…
  model TEXT,
  prompt_version TEXT,
  policy_version TEXT,
  status TEXT NOT NULL,                       -- running|completed|failed
  metrics TEXT,                               -- json
  created_by TEXT,
  created_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (workspace, eval_run_id)
);

CREATE TABLE IF NOT EXISTS eval_cases (
  workspace TEXT NOT NULL,
  org TEXT,
  family TEXT NOT NULL,
  case_id TEXT NOT NULL,
  input TEXT NOT NULL,                        -- json
  expected TEXT NOT NULL,                     -- json golden output
  tags TEXT,                                  -- json array — e.g. negation|
                                              -- qualifier slices (§15.9)
  created_at TEXT,
  PRIMARY KEY (workspace, family, case_id)
);

CREATE TABLE IF NOT EXISTS eval_results (
  workspace TEXT NOT NULL,
  org TEXT,
  eval_run_id TEXT NOT NULL,
  family TEXT NOT NULL,
  case_id TEXT NOT NULL,
  verdict TEXT NOT NULL,                      -- pass|fail|skip
  scores TEXT,                                -- json
  detail TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, eval_run_id, family, case_id)
);
-- Append-only — a re-run is a new eval_run.

-- --- indexes ---
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs (workspace, ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events (workspace, ticket_id);
CREATE INDEX IF NOT EXISTS idx_notifications_ws ON notifications (workspace, read_at);
CREATE INDEX IF NOT EXISTS idx_gate_items_open ON gate_items (workspace, cleared_at);
CREATE INDEX IF NOT EXISTS idx_entities_product ON entities (product, kind);
CREATE INDEX IF NOT EXISTS idx_board_items_ws ON board_items (workspace, board);
CREATE INDEX IF NOT EXISTS idx_tickets_feature ON tickets (workspace, feature);
CREATE INDEX IF NOT EXISTS idx_doc_versions_latest ON doc_versions (workspace, subject, doc, version);
-- addendum (wp-131)
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases (workspace, status);
CREATE INDEX IF NOT EXISTS idx_release_items_release ON release_items (workspace, release_id);
CREATE INDEX IF NOT EXISTS idx_deployments_release ON deployments (workspace, release_id);
CREATE INDEX IF NOT EXISTS idx_gate_results_release ON release_gate_results (workspace, release_id);
CREATE INDEX IF NOT EXISTS idx_changesets_status ON changesets (workspace, status);
CREATE INDEX IF NOT EXISTS idx_statement_versions_stmt ON statement_versions (workspace, statement_id, version);
CREATE INDEX IF NOT EXISTS idx_statement_relations_src ON statement_relations (workspace, src);
CREATE INDEX IF NOT EXISTS idx_clarifications_stmt ON statement_clarifications (workspace, statement_id);
CREATE INDEX IF NOT EXISTS idx_statement_decisions_stmt ON statement_decisions (workspace, statement_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_stmt ON statement_artifact_links (workspace, statement_id);
CREATE INDEX IF NOT EXISTS idx_interview_messages_session ON interview_messages (workspace, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_question_candidates_session ON question_candidates (workspace, session_id, status);
CREATE INDEX IF NOT EXISTS idx_review_sessions_subject ON review_sessions (workspace, subject);
CREATE INDEX IF NOT EXISTS idx_review_findings_review ON review_findings (workspace, review_id, status);
CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments (workspace, review_id);
CREATE INDEX IF NOT EXISTS idx_review_decisions_review ON review_decisions (workspace, review_id);
CREATE INDEX IF NOT EXISTS idx_assumptions_status ON assumptions (workspace, status);
CREATE INDEX IF NOT EXISTS idx_quality_debt_status ON quality_debt (workspace, status);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results (workspace, eval_run_id);
