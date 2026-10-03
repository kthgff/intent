# DB SCHEMA — sprint-runner storage contract

Companion to `SCHEMAS.md`. Draft 2026-10-03.
One schema, two backends: **SQLite** (solo, `sqlite:///…`) · **Postgres**
(team/daemon, `postgres://…`) via `storage_url`. Vectors: sqlite-vec /
pgvector — same logical columns.

**Data classes** (per PRD storage architecture):
*coordination* (leases, runs, claims, presence, notifications) and
*query/reference* (dossiers, entities, relations, embeddings, ticket +
event projections, metrics). Everything here is ephemeral-or-regenerable —
git keeps the approval/audit truth.

**Workspace keying**: `workspace` = the tickets repo a subject belongs
to (`tickets_repos.<name>`). Ticket ids (`SR-NNNN`, tracker keys) are
unique per WORKSPACE only — every ticket-keyed table is
workspace-qualified so the unified inbox (S-01) queries across all of
them. **`subject`** = what a coordination object attaches to: a ticket
id, or `survey:<scope>:<name>` / `probe:<repo>` / `import:<source>` /
`interview:<run>` for non-ticket work (those runs have no ticket, but
still need leases, claims, and gate items).

```sql
-- --- meta ---
schema_meta(version INTEGER, applied_at TEXT);          -- current: 1

-- --- coordination ---
leases(                                  -- fencing for stage runs
  workspace TEXT, subject TEXT, stage TEXT, attempt INT,
  holder TEXT,                           -- install/user id (actor:)
  acquired_at TEXT, ttl_s INT, heartbeat_at TEXT,
  PRIMARY KEY(workspace, subject, stage, attempt));
claims(                                  -- human-gate items
  workspace TEXT, subject TEXT, gate TEXT,-- the gate instance, e.g.
                                         -- 'prd-review', 'merge' —
                                         -- matches gate_items.gate
  claimed_by TEXT, claimed_at TEXT, ttl_s INT,
  PRIMARY KEY(workspace, subject, gate));
runs(
  id TEXT PRIMARY KEY,                   -- e.g. team-a/ABC-123/003-implement
  workspace TEXT, subject TEXT,
  ticket_id TEXT,                        -- null for non-ticket subjects
  stage TEXT, attempt INT,
  backend TEXT, model TEXT, depth TEXT,
  pid INT, worktree TEXT, status TEXT,   -- pending|leased|running|paused|
                                         -- exited|validated|done|failed|
                                         -- killed|stalled
                                         -- worktree set on single-repo
                                         -- runs; multi-repo → ticket_repos
  started_at TEXT, heartbeat_at TEXT, exited_at TEXT,
  sentinel TEXT, sentinel_raw TEXT,
  cost_usd REAL,                          -- null when not token-computable
  tokens_in INT, tokens_out INT, tokens_cached INT,
  usage_source TEXT,                      -- reported|partial|estimated
  duration_s REAL,
  run_dir TEXT);                         -- artifacts path (not blobs)
presence(install_id TEXT PRIMARY KEY, actor TEXT, last_seen TEXT);
notifications(id INTEGER PRIMARY KEY, workspace TEXT, subject TEXT,
  kind TEXT, payload TEXT, created_at TEXT, read_at TEXT);

-- --- ticket projections (rebuilt from git frontmatter on every pull) ---
tickets(                                 -- what inbox/lists query — the
  workspace TEXT, ticket_id TEXT,        --  DB never re-parses ticket.md
  title TEXT, status TEXT, priority TEXT, depth TEXT,
  backend TEXT, model TEXT, repos TEXT,  -- json array
  parent TEXT, depends_on TEXT,          -- json array
  spec_score INT, spec_hash TEXT,        -- hash of spec inputs at spec
                                         -- completion → stale-spec check
  blocked_reason TEXT,                   -- env|agent|<text> when blocked
  updated_at TEXT,
  PRIMARY KEY(workspace, ticket_id));
ticket_repos(                            -- one row per repo a ticket touches
  workspace TEXT, ticket_id TEXT, repo TEXT,
  branch TEXT, worktree TEXT,
  pr_url TEXT, pr_state TEXT,            -- null|open|merged|closed
  ci_state TEXT,                         -- pending|green|failing
  merged_sha TEXT,
  PRIMARY KEY(workspace, ticket_id, repo));
-- Headline status is a rollup: `merged` iff EVERY ticket_repos row is
-- merged — a cross-repo ticket can sit in ci-watch with mixed
-- per-repo states, and S-05/S-09 render the rows.

-- --- knowledge base ---
dossiers(
  id TEXT,                               -- '<scope>:<name>:<section>'
  scope TEXT,                            -- repo | product
  name TEXT, section TEXT,               -- SCHEMAS §11 section names
  version INT, content TEXT,             -- markdown
  surveyed_at TEXT, sources_used TEXT,   -- csv
  stale INT DEFAULT 0,                   -- flagged by refresh diff
  edited_by TEXT, edited_at TEXT,        -- human correction
  PRIMARY KEY(id, version));
entities(
  id TEXT PRIMARY KEY, product TEXT, kind TEXT,
  name TEXT, canonical TEXT, aliases TEXT, -- json array
  source TEXT,                           -- inferred|confirmed|imported
  evidence TEXT);
relations(
  subject TEXT, predicate TEXT, object TEXT,
  evidence TEXT, source TEXT,
  PRIMARY KEY(subject, predicate, object));
embeddings(                              -- sqlite-vec / pgvector
  object_ref TEXT, model TEXT, vector BLOB,
  PRIMARY KEY(object_ref, model));

-- --- projections (rebuildable — nuke + replay events.jsonl) ---
events_idx(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT, ticket_id TEXT, ts TEXT, stage TEXT,
  actor_type TEXT, actor_id TEXT,
  event TEXT, run TEXT, refs TEXT, data TEXT,        -- json
  cost_usd REAL, tokens_in INT, tokens_out INT, tokens_cached INT,
  usage_source TEXT, duration_s REAL, human_minutes REAL);
usage_calls(                              -- per-call ledger projection
  run_id TEXT, seq INT, ts TEXT, model TEXT,
  tokens_in INT, tokens_out INT, tokens_cached INT,
  latency_s REAL, source TEXT,            -- reported|estimated
  PRIMARY KEY(run_id, seq));              -- from usage.json (SCHEMAS §13)
gate_items(                              -- materialized inbox
  workspace TEXT, subject TEXT, gate TEXT,-- gate instance name —
  kind TEXT,                             --  claims.gate matches it
  -- kind ∈ question|approval|review|failure|escalation|split-plan|repair
  surfaced_at TEXT, cleared_at TEXT,     -- dwell = human_minutes source
  blocked_agent INT, priority TEXT,
  PRIMARY KEY(workspace, subject, gate));
```

## Rules

- **Rebuildable**: `tickets`, `ticket_repos`, `events_idx`,
  `gate_items`, `usage_calls`, `embeddings` may be dropped and rebuilt
  from git (frontmatter scan + events.jsonl + usage.json replay) +
  re-embedding; never hold unique truth.
- **Live usage**: `runs.tokens_*` update mid-run as adapters stream
  per-message usage (ADAPTERS usage contract — an internal stream, not
  a ledger event); `usage_calls` is populated at run end from
  `usage.json`.
- **Heartbeats are conductor-observed**: each reconcile tick records
  pid liveness + artifact/log mtime into `runs.heartbeat_at` — the
  detached process never touches the DB. `stalled` after ~2 missed
  ticks; lease `ttl_s` default 300.
- **Notifications**: generated on `gate_items` insert and on
  `run_failed`/`run_killed`/`blocked` events.
- **Dossier versioning**: refresh writes `version+1`, flags `stale` on
  unchanged-but-older sections; humans' `edited_by` survives re-survey
  (conflict → human version wins, flagged for review).
- **Retention**: `notifications`/`presence` pruned >30d; transcripts
  stay as `run_dir` paths (DB holds refs, not blobs).
- **Actor identity**: every write carries the install/user id
  (SETTINGS `actor:`) — shared-queue attribution.
