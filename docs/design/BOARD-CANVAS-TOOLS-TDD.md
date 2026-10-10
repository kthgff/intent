# BOARD-CANVAS-TOOLS-TDD — toolbar extensions & canvas additions

Status: **proposed**. Extends BOARD-CANVAS-TDD (S-16 v2) and D57–D63.
Scope: everything discussed in the toolbar-extensions review — select/lasso
bulk ops, comment pins, vote stamps, timer, minimap, cluster/auto-layout,
frames-as-presentations, and the drawing layer (pen/shapes/highlighter).

Design intent: every addition either rides an existing durable concept
(`feedback` kind, `zone` geometry, `importance`, connectors) or is an
honest new durable entity. No presentation-only state that silently
deserves to be durable.

---

## 1. Feature inventory → durability class

| Feature | Durability | Data model |
| --- | --- | --- |
| Select tool + lasso | transient | selection is RF state; actions reuse the D62 bulk PATCH |
| Comment pin | durable | `board_items` `kind='feedback'` (enum already exists) + position |
| Vote stamp | durable | new `board_item_votes` table (voter, item, stamp, run id) |
| Timer | transient | chrome-level state, `aria-live`; nothing persisted |
| Minimap | transient | RF `<MiniMap>`; zoom-publishes via existing viewport store |
| Cluster / auto-layout | durable writes | one batch PATCH with `expected_updated_at` per row |
| Frame presentation mode | semi-durable | `zone` meta: `presentation_order` int on board_items (nullable) |
| Pen / shapes / highlighter | durable, new entity | `board_annotations` table (stroke paths / shape geometry) |
| Vote session | durable span | `board_vote_sessions` (opens/closes a counting window) |

Transient means "lost on reload by design" — stated explicitly so nobody
"fixes" it later. Everything durable flows through the same OCC-fenced,
SSE-broadcast write path as existing canvas ops; nothing gets a bespoke
mutation channel.

## 2. Architecture

### 2.1 Front-end structure

```
board-canvas/
  BoardCanvas.tsx        — orchestrator (unchanged role)
  tools/
    rail.tsx             — ToolRail generalized: groups + badges
    select.ts            — lasso math (drag rect → node hit-test)
    comment.ts           — pin placement + feedback item create
    vote.ts              — stamp click handler + session awareness
    draw/                — pen/shape/highlight stroke capture
      strokes.ts         — pointer → polyline (RDP simplification)
      shapes.ts          — rect/ellipse/arrow param geometry
  overlays.tsx           — + VoteBadge, CommentThread, TimerChip
  minimap.tsx            — wrapper isolating RF MiniMap styling
  presentation.tsx       — frame traversal (zone order, fitView)
```

`CanvasTool` union extends: `'draw' | 'comment' | 'vote'`. Create tools
stay in `CREATE_TOOLS`; drawing tools route pointer events to a
stroke-capture layer instead of `createAt`.

### 2.2 Lasso & bulk ops

- `tool='select'` + drag on pane draws a marquee rect (viewport coords →
  flow coords via `screenToFlowPosition`, already used by `createAt`).
- Nodes whose bounds intersect the rect join RF selection; the existing
  multi-select bar (D59 chrome) gains the D62 bulk verbs: set status,
  set importance, move to tray, discard — same batch PATCH, same
  `expected_updated_at` per row, same confirm ≥10 + undo toast contract.
- Guard: locked (consumed/frozen) items enter selection but are excluded
  from writes — visually marked, announced in the bar ("2 locked items
  unaffected"), never silently dropped (fail-closed idiom).

### 2.3 Comment pins

- `tool='comment'`: click places a pin → creates `board_items` row
  `kind='feedback'`, `note_kind='comment'`, `ref` = target item id when
  dropped on a node (else free-standing), position at click point.
- Pins render compact (avatar-free: initials + count badge); click opens
  a thread popover. Resolved comments move to `status='archived'`
  (existing lifecycle), not deleted.
- SSE already broadcasts `board_items` writes → threads update live for
  concurrent users.

### 2.4 Vote stamps + sessions

- New table `board_item_votes(workspace, board, item_id, voter, stamp,
  session_id, created_at)`; PK `(workspace, board, item_id, voter,
  session_id)` — one vote per voter per session, re-vote = UPDATE under
  OCC (`expected` on session row, not item).
- `stamp ∈ {up, down, question}` maps to importance *signal only* — a
  vote never writes `importance` directly; tally displays on the node
  badge (`canvas-node-votes`), synthesis can consume the aggregate.
- `board_vote_sessions(workspace, board, id, opened_by, closes_at,
  status)` — open/close is a lifecycle PATCH so "session closed" is
  durably enforced server-side (fail-closed: votes to a closed session
  409).
- Client: `tool='vote'` stamps on click; badges show tally while a
  session is open or when `?votes=show`.

### 2.5 Timer, minimap, presentation

- Timer: chrome chip in the topbar-right cluster; start/pause/reset;
  `aria-live="off"` ticking, `polite` at boundaries. Pure client state.
- Minimap: `<MiniMap>` bottom-left, masked by `prefers-reduced-motion`
  transition rules; uses existing `--canvas-*` tokens; hidden <900px
  (read mode keeps chrome minimal per D59).
- Presentation: zones gain optional `presentation_order` (int, nullable).
  Present mode = a tool-bar toggle that sequences `fitView` to each
  ordered zone (respecting reduced-motion duration rules), Esc exits.
  Zero new entities — an ordering column on a durable kind.

### 2.6 Drawing layer — the only genuinely new durable entity

```
board_annotations(
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  board TEXT NOT NULL,
  kind TEXT NOT NULL,            -- stroke|rect|ellipse|arrow|highlight
  geometry TEXT NOT NULL,        -- JSON: pts[]|bounds, z=behind-nodes
  color TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT);
```

- Rendered as one SVG layer between `<Background>` and nodes — not RF
  nodes (they must not participate in selection/connect/zoom-fit
  semantics of semantic objects).
- Writes go through `POST /boards/:board/annotations` +
  `PATCH/DELETE /annotations/:id` with the same bearer auth, OCC fence,
  and SSE broadcast as board items.
- Strokes simplified client-side (Ramer–Douglas–Peucker, ε=1.5px) before
  persist; cap 2k points/stroke server-side (fail-closed validation).

### 2.7 API + core contract changes

- `enums.ts`: `BOARD_ANNOTATION_KINDS`, `VOTE_STAMPS`,
  `VOTE_SESSION_STATUSES`; `NOTE_KINDS` + `'comment'`.
- `schemas.ts`: `AnnotationSchema`, `VoteSchema`, session open/close
  schemas; zod-validated at the route boundary per API.md.
- Migrations: `board_item_votes`, `board_vote_sessions`,
  `board_annotations`, `board_items.presentation_order` (nullable int).
  New files only — D58: applied migrations are immutable.
- SSE: annotation/vote writes publish on the existing board stream.

## 3. Behavioral contracts

- **Selection parity**: every bulk verb reachable by lasso is reachable
  in Easy Edit — same command objects, same undo history.
- **Concurrency**: votes and annotations are append/OCC like items;
  a concurrent conflict surfaces the human-language conflict toast
  (D61), never a silent drop.
- **Read mode <900px**: select/vote/comment allowed (read-adjacent
  participation), draw/present hidden; mutation chrome still collapses
  per D59.
- **Reduced motion**: marquee snap, minimap transitions, presentation
  `fitView` durations → 0.
- **Locked objects**: never moved by cluster/auto-layout; connectors to
  them stay `active` — cluster writes only geometry of mutable rows.

## 4. Test plan

Per package (`vitest`), mirroring `easy-edit-view.test.tsx` patterns:

**ui — unit**
- `select.test.ts`: rect-intersection hit-test incl. zoom/pan transform,
  locked-node exclusion, empty-rect deselect.
- `strokes.test.ts`: RDP simplification bounds, degenerate inputs
  (1 pt, collinear, >2k pts → fail-closed error).
- `vote.test.ts`: tally derivation, one-vote-per-voter-per-session
  idempotency, closed-session rejection path.
- `presentation.test.ts`: zone ordering, un-ordered zones excluded,
  Esc exit + reduced-motion zero-duration.

**ui — view**
- lasso → multi-bar → bulk discard ≥10 → confirm + undo (reuses D62
  cases; new case ids `case:canvas-tools-01…`).
- comment pin create → thread popover → archive → SSE repaint.
- vote badge visibility gated on open session / `?votes=show`.
- presentation stepping order + focus management.

**api/store**
- migrations apply + `schema_meta` hash recorded (D58 discipline).
- votes: PK conflict → update path; closed session → 409.
- annotations: zod rejects >2k-point geometry, unknown `kind`.
- batch PATCH with mixed locked/mutable → only mutable rows write,
  response reports skipped ids.

**e2e smoke (manual checklist until playwright exists)**
- lasso 3 stickies → discard → undo restores positions+status.
- open vote session → stamp 2 stickies → reload → tallies persist.
- draw stroke → reload → persists; delete annotation → gone for second
  client via SSE.

## 5. Phasing / work packages

| WP | Content | Depends |
| --- | --- | --- |
| wp-ee1 | select tool + lasso + bulk-bar reuse | none |
| wp-ee2 | comment pins (`kind='feedback'`) | none |
| wp-ee3 | vote stamps + sessions (new tables) | migration |
| wp-ee4 | timer + minimap + presentation order | none |
| wp-ee5 | drawing layer (`board_annotations`) | migration |

Each lands behind the existing `ui.idea_canvas_v2` flag; wp-ee5 adds
`ui.canvas_draw` since it's the largest durable-surface addition.

## 6. TRACKER/contract notes

- `presentation_order` on `board_items` and the two vote tables are
  **contract amendments** — new durable columns/routes; log under a new
  D-row at implementation, not retroactively.
- `kind='feedback'` pins are within the existing enum — no amendment,
  but `s-16` doc needs a paragraph (comment threads on canvas).
- The dot-grid→line-grid amendment (D59) and this doc are orthogonal —
  grid is chrome, not geometry.
