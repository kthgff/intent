-- 0014_vote_session_open_unique.sql — one open vote session per board,
-- enforced in the DB (D63 addition beyond TOOLS-TDD §2.7 text). The
-- API's check-then-insert 409 rides on this backstop; D58: shipped as a
-- new migration because 0013 was already applied when this landed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_vote_sessions_open
  ON board_vote_sessions (workspace, board) WHERE status = 'open';
