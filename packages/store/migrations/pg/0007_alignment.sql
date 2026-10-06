-- 0007_alignment.sql — wp-112 continuous alignment (D37 Phase B,
-- SCHEMAS §18, INTELLIGENCE §5).
--
-- alignment_runs    — one intended/implemented/verified comparison
--                     execution; the durable home of the
--                     alignment-findings.json artifact. `on-merge`
--                     runs coalesce on (workspace, scope, trigger_sha)
--                     so a duplicated merge event never forks history.
-- alignment_findings — persisted §18 findings. `status` moves ONLY
--                     through the OCC decide path; a re-run refreshes
--                     evidence fields but never reopens a settled
--                     finding (status deliberately absent from the
--                     upsert's UPDATE set at the code layer).
-- alignment_finding_decisions — append-only human-decision audit
--                     (mirrors finding_resolutions).

CREATE TABLE IF NOT EXISTS alignment_runs (
  workspace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,                       -- SR-…|F-…|I-…|release:<id>
  trigger TEXT NOT NULL,                     -- manual|on-merge
  trigger_sha TEXT,                          -- merged head that fired it
  index_heads TEXT,                          -- json [{repo, commit_sha}]
  status TEXT NOT NULL,                      -- running|done|failed
  finding_count INT NOT NULL DEFAULT 0,
  artifact TEXT,                             -- alignment-findings.json
  tokens_in BIGINT,
  tokens_out BIGINT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (workspace, run_id)
);

-- One on-merge run per (workspace, scope, merged head) — duplicate
-- merge events coalesce; manual runs (trigger_sha NULL) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alignment_runs_dedupe
  ON alignment_runs (workspace, scope, trigger_sha)
  WHERE trigger = 'on-merge' AND trigger_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alignment_runs_scope
  ON alignment_runs (workspace, scope, created_at);

CREATE TABLE IF NOT EXISTS alignment_findings (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,                          -- aln_…
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- SCHEMAS §18 kinds
  severity TEXT NOT NULL,                    -- info|minor|major|blocker
  claim TEXT NOT NULL,                       -- reviewable hypothesis
  confidence REAL NOT NULL,
  evidence_refs TEXT NOT NULL,               -- json array, >=1 ref
  disconfirming_refs TEXT,                   -- json array
  freshness TEXT NOT NULL,                   -- current|stale
  suggested_next_check TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open|dismissed|verified|resolved
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX IF NOT EXISTS idx_alignment_findings_scope
  ON alignment_findings (workspace, scope, status);

-- Append-only human-decision audit (status transitions are also
-- evented via `alignment_finding_decided` in `events`).
CREATE TABLE IF NOT EXISTS alignment_finding_decisions (
  workspace TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  seq INT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, finding_id, seq)
);
