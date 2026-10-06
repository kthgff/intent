-- 0009_workspace_pks.sql — code-review fixes (D52):
--
--   * incidents / telemetry_sources had GLOBAL `id` primary keys while
--     their ids are allocated per workspace (INC-NNNN comes from
--     projects.next_incident_seq; source ids are operator-chosen) — a
--     second workspace could hijack or silently collide with another
--     workspace's rows. Both become composite (workspace, id) PKs.
--     No FK constraints reference either table (the schema uses
--     app-level refs, never REFERENCES), so nothing else migrates.
--   * release_approvals loses its append-only UPDATE trigger so a
--     re-verdict on the same manifest_version by the same approver is
--     recorded (appendReleaseApproval now upserts). DELETE stays
--     blocked — approvals can be superseded, never erased.
--   * the wp-132 doc-kind rename backfill moves here out of
--     0001_init.sql — migrate() checksums applied files, so editing
--     0001 in place drift-failed every existing database at boot.

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_pkey;
ALTER TABLE incidents ADD PRIMARY KEY (workspace, id);

ALTER TABLE telemetry_sources DROP CONSTRAINT IF EXISTS telemetry_sources_pkey;
ALTER TABLE telemetry_sources ADD PRIMARY KEY (workspace, id);

DROP TRIGGER IF EXISTS veto_release_approvals_append_only_upd
  ON release_approvals;

-- --- vocabulary rename (wp-132, PRD §15.2) — moved from 0001 ---
-- Doc kinds prd.md → rs.md (Requirements Specification) and
-- test.md → vs.md (Verification Specification). No-op on fresh
-- installs; idempotent for databases that ran the amended 0001.
UPDATE doc_versions SET doc = 'rs.md' WHERE doc = 'prd.md';
UPDATE doc_versions SET doc = 'vs.md' WHERE doc = 'test.md';
