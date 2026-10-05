-- 0004: code-intelligence indexes (INTELLIGENCE §4, D37, wp-110).
--
-- The repo_indexes / code_units / code_edges / retrieval_evaluations
-- tables ship in 0001 (DB-SCHEMA "evidence plane / code intelligence").
-- This migration adds the access paths the indexer + hybrid retrieval
-- need; it does NOT change any column shape.
--
-- Retrieval is always scoped to an authorized (workspace, repo,
-- commit_sha) head, so every hot index leads with those columns. The
-- GIN index backs Postgres full-text search over code unit content.

CREATE INDEX IF NOT EXISTS idx_repo_indexes_head
  ON repo_indexes (workspace, repo, status);

CREATE INDEX IF NOT EXISTS idx_code_units_head
  ON code_units (workspace, repo, commit_sha);

CREATE INDEX IF NOT EXISTS idx_code_units_path
  ON code_units (workspace, repo, commit_sha, path);

-- Content-addressed reuse: unchanged content maps to the same hash
-- across commits (semantic recall maps hash → authorized rows).
CREATE INDEX IF NOT EXISTS idx_code_units_hash
  ON code_units (content_hash);

CREATE INDEX IF NOT EXISTS idx_code_units_fts
  ON code_units USING GIN (fts);

CREATE INDEX IF NOT EXISTS idx_code_edges_head
  ON code_edges (workspace, repo, commit_sha);

CREATE INDEX IF NOT EXISTS idx_code_edges_subject
  ON code_edges (workspace, repo, commit_sha, subject_ref);
