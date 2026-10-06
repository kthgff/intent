-- 0010_approval_history.sql — code-review W6 (D56):
--
--   release_approvals upserts on re-verdict (0009) so the LATEST row
--   holds the current decision — but the superseded verdict was lost.
--   This append-only companion table records EVERY verdict in order;
--   the approvals table is the current state, this table is the audit.
--   Deletes/updates are prohibited by the shared veto_append_only()
--   trigger, matching events-table semantics.

CREATE TABLE IF NOT EXISTS release_approval_history (
  seq BIGSERIAL PRIMARY KEY,
  workspace TEXT NOT NULL,
  org TEXT,
  release_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS release_approval_history_release
  ON release_approval_history (workspace, release_id, manifest_version);

DROP TRIGGER IF EXISTS veto_approval_history_no_upd ON release_approval_history;
CREATE TRIGGER veto_approval_history_no_upd BEFORE UPDATE ON release_approval_history
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();

DROP TRIGGER IF EXISTS veto_approval_history_no_del ON release_approval_history;
CREATE TRIGGER veto_approval_history_no_del BEFORE DELETE ON release_approval_history
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();
