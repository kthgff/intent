-- 0006_release_invariants.sql — wp-134 Release Center hardening.
--
-- DELIVERY invariant 5 is enforced fail-closed at the DB layer too —
-- a partial release row (partial_ac non-null) is invalid without an
-- item-level human approver, regardless of the write path that
-- produced it. The engine rejects it first; this constraint is the
-- last line of defense.

ALTER TABLE release_items
  ADD CONSTRAINT release_items_partial_ac_approved
  CHECK (partial_ac IS NULL OR approved_by IS NOT NULL);
