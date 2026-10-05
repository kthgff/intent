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
  name TEXT,
  next_ticket_seq INTEGER NOT NULL DEFAULT 1,
  next_feature_seq INTEGER NOT NULL DEFAULT 1,
  next_initiative_seq INTEGER NOT NULL DEFAULT 1,
  settings TEXT,                              -- jsonb-serialized overrides
  created_at TEXT
);

-- --- boards / canvas ---
CREATE TABLE IF NOT EXISTS boards (
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  name TEXT,
  created_at TEXT,
  PRIMARY KEY (workspace, board)
);

CREATE TABLE IF NOT EXISTS board_items (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
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
  created_at TEXT,
  updated_at TEXT
);

-- --- hierarchy (D26) ---
CREATE TABLE IF NOT EXISTS initiatives (
  workspace TEXT NOT NULL,
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
  feature TEXT NOT NULL,
  initiative TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  priority TEXT,
  serves TEXT,                                -- json array — inherited chain (D33)
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, feature)
);

-- --- tickets (TRUTH — was a frontmatter projection) ---
CREATE TABLE IF NOT EXISTS tickets (
  workspace TEXT NOT NULL,
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
                                              -- {tokens, model} (D29)
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
