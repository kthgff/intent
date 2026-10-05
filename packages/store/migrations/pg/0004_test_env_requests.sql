-- 0004_test_env_requests.sql — wp-157: durable test-environment
-- requests (PRD §15.10).
--
-- A stage that declares a `test_env` spec raises a durable request
-- (what environment, what data/fixtures, who can provision, expiry).
-- The run blocks until a human fulfils (provisioning evidence) or
-- explicitly waives (rationale) it; the request row is the audit trail
-- and `run_id` links provisioning evidence back to the run that needed
-- the environment. `projects.next_test_env_seq` allocates `TE-NNNN`
-- ids the same transactional way every other generated id does.
--
-- A new numbered migration keeps already-applied 0001–0003 checksums
-- intact (schema_meta drift fails closed).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS next_test_env_seq INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS test_env_requests (
  workspace TEXT NOT NULL,
  org TEXT,
  request_id TEXT NOT NULL,                   -- TE-NNNN
  subject TEXT NOT NULL,                      -- requesting ticket/subject
  ticket_id TEXT,
  feature TEXT,                               -- feature whose spec was
                                              -- inherited, when applicable
  stage TEXT NOT NULL,                        -- implement|verify|…
  run_id TEXT,                                -- run that needed the env —
                                              -- provisioning evidence links
                                              -- back to it (set at launch)
  spec TEXT NOT NULL,                         -- json TestEnvSpec snapshot
  status TEXT NOT NULL,                       -- pending|fulfilled|waived|
                                              -- expired
  requested_by TEXT,
  requested_at TEXT NOT NULL,
  provisioner TEXT,                           -- who can provision
  expires_at TEXT,                            -- request expiry
  fulfilled_by TEXT,
  fulfilled_at TEXT,
  evidence TEXT,                              -- provisioning evidence
                                              -- (url/ref/note — never
                                              -- fabricated)
  waived_by TEXT,
  waived_at TEXT,
  waiver_rationale TEXT,                      -- mandatory on waive
  expired_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, request_id)
);

CREATE INDEX IF NOT EXISTS test_env_requests_subject_idx
  ON test_env_requests (workspace, subject, status);
