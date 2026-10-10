-- 0015_board_chat.sql — Board Assistant (BOARD-CHAT-PRD/TDD, wp-161).
--
-- Two additive changes, no existing-path alteration:
--   1. interview_messages.created_by — per-turn actor attribution for
--      the shared board thread (contract amendment 1; NULL on
--      pre-existing rows, session.created_by is the display fallback).
--   2. board_proposals — the durable proposal queue: every assistant
--      board mutation lands here as a pending row and is committed
--      through the single-item write path only on human accept
--      (proposals-only writes, PRD R3). status:
--      pending|accepted|rejected|stale|superseded.

ALTER TABLE interview_messages ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE TABLE IF NOT EXISTS board_proposals (
  workspace TEXT NOT NULL,
  org TEXT,
  proposal_id TEXT NOT NULL,
  board TEXT NOT NULL,
  -- The board's assistant thread session (interview_sessions row).
  session_id TEXT NOT NULL,
  -- Checkpoint grouping — the accept-all scope for structural batches.
  batch_id TEXT,
  -- Transcript seq (interview_messages.seq) that produced the proposal.
  seq INTEGER,
  -- BOARD_PROPOSAL_OPS value.
  op TEXT NOT NULL,
  -- json — the full ProposalOp object (self-contained, includes `op`).
  payload TEXT NOT NULL,
  -- OCC fence captured at draft time for item-targeting ops.
  base_updated_at TEXT,
  -- json array of related item ids (explainability).
  anchor TEXT,
  -- json {statement_ids, branch} — provenance chain to the ledger.
  provenance TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, proposal_id)
);

CREATE INDEX IF NOT EXISTS idx_board_proposals_board
  ON board_proposals (workspace, board, status);
