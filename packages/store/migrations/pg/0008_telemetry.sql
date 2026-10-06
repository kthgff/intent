-- 0008_telemetry.sql — wp-120 telemetry + incident intelligence
-- (D37 Phase C, SCHEMAS §19, INTELLIGENCE §6).
--
-- telemetry_sources / error_signatures / incidents already ship in
-- 0001_init.sql (D40 — schema was frozen ahead of the wave). This
-- migration adds the wp-120 lifecycle tables:
--
-- incident_decisions         — append-only human-decision audit for
--                              incident status transitions (mirrors
--                              alignment_finding_decisions; OCC moves
--                              happen through decideIncident only).
-- incident_ticket_proposals  — draft-ticket gate: an incident may
--                              PROPOSE a ticket; the row stays `draft`
--                              until a human approve/reject decision —
--                              nothing enters committed scope without
--                              it (retro-proposal parity).
--
-- Raw events are never stored (INTELLIGENCE §6.1): error_signatures
-- holds only sanitized/deduplicated patterns + backend locators.

CREATE TABLE IF NOT EXISTS incident_decisions (
  workspace TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  seq INT NOT NULL,
  status TEXT NOT NULL,                     -- open|investigating|resolved|closed
  actor TEXT NOT NULL,
  rationale TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, incident_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_incident_decisions_incident
  ON incident_decisions (workspace, incident_id);

CREATE TABLE IF NOT EXISTS incident_ticket_proposals (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,                          -- prop_…
  incident_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  draft TEXT,                                -- json {work_type, severity, …}
  status TEXT NOT NULL DEFAULT 'draft',      -- draft|approved|rejected
  board_item_id TEXT,                        -- set on approve
  decided_by TEXT,
  decided_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX IF NOT EXISTS idx_incident_proposals_incident
  ON incident_ticket_proposals (workspace, incident_id, status);

-- incident_decisions is append-only audit — same DB-level enforcement
-- as events / alignment_finding_decisions (0002 veto_append_only).
DROP TRIGGER IF EXISTS veto_incident_decisions_append_only_upd ON incident_decisions;
DROP TRIGGER IF EXISTS veto_incident_decisions_append_only_del ON incident_decisions;
CREATE TRIGGER veto_incident_decisions_append_only_upd
  BEFORE UPDATE ON incident_decisions
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();
CREATE TRIGGER veto_incident_decisions_append_only_del
  BEFORE DELETE ON incident_decisions
  FOR EACH ROW EXECUTE FUNCTION veto_append_only();

-- incidents carries the INC-NNNN allocator slot on projects.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS next_incident_seq INTEGER NOT NULL DEFAULT 1;
