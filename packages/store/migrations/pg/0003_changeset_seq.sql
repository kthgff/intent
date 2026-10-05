-- 0003_changeset_seq.sql — wp-140: CS-NNNN allocator for changesets.
--
-- wp-131 created the changesets/changeset_items tables but no id
-- allocator — every other generated id (SR-/F-/I-/REL-NNNN) bumps a
-- projects.next_*_seq counter transactionally (DB-SCHEMA "Id
-- allocation"). This adds the missing counter; a new numbered
-- migration keeps already-applied 0001 checksums intact.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS next_changeset_seq INTEGER NOT NULL DEFAULT 1;
