-- 0002_relations_append_only.sql — D37 relation edge metadata +
-- DB-level append-only enforcement (code-review R1 findings).
--
-- relations gains the columns DB-SCHEMA.md already specifies:
-- confidence (required on inferred links), verification
-- (suggested|auto-verified|verified|rejected), valid_at
-- (commit/version/time boundary).
ALTER TABLE relations ADD COLUMN IF NOT EXISTS confidence REAL;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS verification TEXT;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS valid_at TEXT;

-- events is append-only truth and doc_versions are immutable (DB-SCHEMA
-- / SCHEMAS §7 / D24): enforce it at the DB layer, not just by the
-- absence of mutator methods. run_artifacts stays mutable —
-- putArtifact upserts in place (answers/verdict write-backs are the
-- same row's content).
CREATE OR REPLACE FUNCTION veto_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS veto_events_append_only_ins ON events;
DROP TRIGGER IF EXISTS veto_events_append_only_upd ON events;
DROP TRIGGER IF EXISTS veto_events_append_only_del ON events;
CREATE TRIGGER veto_events_append_only_upd
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();
CREATE TRIGGER veto_events_append_only_del
  BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();

DROP TRIGGER IF EXISTS veto_doc_versions_append_only_upd ON doc_versions;
DROP TRIGGER IF EXISTS veto_doc_versions_append_only_del ON doc_versions;
CREATE TRIGGER veto_doc_versions_append_only_upd
  BEFORE UPDATE ON doc_versions
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();
CREATE TRIGGER veto_doc_versions_append_only_del
  BEFORE DELETE ON doc_versions
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();

-- wp-131 addendum tables with append-only semantics (spec-cited
-- immutability, not just interface discipline):
--   release_manifests    — DELIVERY invariant 3 (approved manifests
--                          never mutate; a scope change cuts a new
--                          version)
--   release_approvals    — approval audit bound to a manifest digest
--   release_gate_results — gate-check audit rows
--   wizard_versions      — versioned wizard config is immutable (§15.9)
--   statement_versions   — statement history (doc_versions discipline)
--   interview_messages   — durable transcript (§15.9)
--   session_snapshots    — resumable-session snapshots
--   review_revisions     — each revision is a pinned head (§15.8)
--   review_decisions     — verdict audit bound to head SHA + baseline
--   finding_resolutions  — finding lifecycle audit
--   delivery_commitments — committed scope is versioned; a version row
--                          never mutates (§15.6)
--   eval_results         — a re-run is a new eval_run
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'release_manifests',
    'release_approvals',
    'release_gate_results',
    'wizard_versions',
    'statement_versions',
    'interview_messages',
    'session_snapshots',
    'review_revisions',
    'review_decisions',
    'finding_resolutions',
    'delivery_commitments',
    'eval_results'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS veto_%I_append_only_upd ON %I', t, t);
    EXECUTE format(
      'DROP TRIGGER IF EXISTS veto_%I_append_only_del ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER veto_%I_append_only_upd BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION veto_append_only()', t, t);
    EXECUTE format(
      'CREATE TRIGGER veto_%I_append_only_del BEFORE DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION veto_append_only()', t, t);
  END LOOP;
END $$;
