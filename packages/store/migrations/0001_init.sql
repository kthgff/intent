-- 0001_init.sql — initial schema, mirrors docs/DB-SCHEMA.md exactly.
-- Every column name/type follows the spec; JSON/array/csv columns are
-- TEXT per the spec's annotations (repos, depends_on, aliases, refs,
-- data, sources_used).

-- --- meta ---
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS presence (
  install_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  workspace TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

-- --- ticket projections ---
CREATE TABLE IF NOT EXISTS tickets (
  workspace TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  depth TEXT,
  backend TEXT,
  model TEXT,
  repos TEXT NOT NULL,
  parent TEXT,
  depends_on TEXT NOT NULL,
  spec_score INTEGER,
  spec_hash TEXT,
  blocked_reason TEXT,
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
  vector BLOB,
  PRIMARY KEY (object_ref, model)
);

-- --- projections (rebuildable) ---
CREATE TABLE IF NOT EXISTS events_idx (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
  blocked_agent INTEGER,
  priority TEXT,
  PRIMARY KEY (workspace, subject, gate)
);

-- --- indexes (query paths named in DB-SCHEMA/SCHEMAS) ---
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs (workspace, ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_idx_ticket ON events_idx (workspace, ticket_id);
CREATE INDEX IF NOT EXISTS idx_notifications_ws ON notifications (workspace, read_at);
CREATE INDEX IF NOT EXISTS idx_gate_items_open ON gate_items (workspace, cleared_at);
CREATE INDEX IF NOT EXISTS idx_entities_product ON entities (product, kind);
