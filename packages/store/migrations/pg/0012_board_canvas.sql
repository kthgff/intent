-- 0012_board_canvas.sql — spatial idea-canvas appearance + connectors.

ALTER TABLE board_items ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS z_index INTEGER;

CREATE TABLE IF NOT EXISTS board_connectors (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (source_item_id) REFERENCES board_items(id),
  FOREIGN KEY (target_item_id) REFERENCES board_items(id)
);

CREATE INDEX IF NOT EXISTS idx_board_connectors_board
  ON board_connectors (workspace, board, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_connectors_active_pair
  ON board_connectors (workspace, board, source_item_id, target_item_id)
  WHERE status = 'active';
