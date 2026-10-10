-- 0013_board_canvas_tools.sql — toolbar-extension durable surface
-- (BOARD-CANVAS-TOOLS-TDD §2.6/§2.7): drawing annotations, vote
-- stamps + vote sessions, and frame presentation ordering.

ALTER TABLE board_items ADD COLUMN IF NOT EXISTS presentation_order INTEGER;

CREATE TABLE IF NOT EXISTS board_annotations (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  kind TEXT NOT NULL,             -- stroke|rect|ellipse|arrow|highlight
  geometry TEXT NOT NULL,         -- JSON validated per kind (z=behind-nodes)
  color TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_annotations_board
  ON board_annotations (workspace, board);

CREATE TABLE IF NOT EXISTS board_vote_sessions (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  opened_by TEXT,
  closes_at TEXT,
  status TEXT NOT NULL,           -- open|closed
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_vote_sessions_board
  ON board_vote_sessions (workspace, board, status);

CREATE TABLE IF NOT EXISTS board_item_votes (
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  item_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stamp TEXT NOT NULL,            -- up|down|question
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (workspace, board, item_id, voter, session_id),
  FOREIGN KEY (item_id) REFERENCES board_items(id),
  FOREIGN KEY (session_id) REFERENCES board_vote_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_board_item_votes_item
  ON board_item_votes (workspace, board, item_id);
