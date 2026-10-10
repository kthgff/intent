# PRD — Easy Edit: non-spatial board-object view

Status: proposed 2026-10-10. Companion to `s-16-board-canvas.md` and
`BOARD-CANVAS-TDD.md` (D57/D59/D61). `PRD.md` §15.3 remains authoritative
for board semantics; this document specifies a new **view** over the same
durable rows — it invents no new entities.

## Problem

The idea canvas is a spatial, direct-manipulation surface. That model is
right for capture and layout, and wrong for a different job users also
have: **triaging and configuring many items quickly**. Renaming twenty
stickies, re-typing a batch of ideas, parking a stale cluster, or moving
tray items onto the board each costs a click-per-card on the canvas, with
semantic fields buried one panel deep in the inspector.

There is already a locate-only preview of the need: the "Board objects"
overlay lists items so keyboard and non-spatial users can find and select
them. It demonstrates that a flat projection is useful — but it cannot
edit anything.

## Goal

A first-class, non-spatial **Easy Edit** mode on the idea board where
board objects appear as dense table rows — not sticky-shaped cards — and
every mutable field of an item is editable from one place, including
multi-select bulk operations and tray promotion.

The table is a **projection**, never a second source of truth. Every
write goes through the existing OCC-fenced REST surface; geometry
(`x`/`y`/`w`/`h`/`z_index`/`zone`) is never displayed and never writable
from this view.

## Non-goals (v1)

- No connector management (topology stays canvas-only — not even a
  read-only column).
- No inline cell editing (the full-page item editor is the only write path).
- No spatial data shown or editable.
- No statement editing (statements are evidence; they stay in the
  inspector where confirm/dispute/correct already lives).
- No `kind` conversion (note↔text↔zone changes have invariants —
  links require `ref`, zones are spatial, images are asset-bound).
- No connector table, no column customization, no per-column sort
  persistence in the URL.

## Placement

A third tab in the existing board topbar toggle:

```text
[ Idea ] [ Easy Edit ] [ Delivery ]
```

- Gated by `ui.idea_canvas_v2` exactly like the canvas — flag-off boards
  see the classic grouped view and no Easy Edit tab.
- Internal mode id: `'edit'` alongside `'idea' | 'delivery'`.
- Deep-linkable via `?view=edit` on the board route.

## Functional requirements

### R1 — Table

- One row per `board_items` row on the board — **including discarded
  items** (muted styling), which the canvas projection hides.
- Columns, fixed order:

| Column | Content | Sort | Filter |
| --- | --- | --- | --- |
| ☐ | checkbox (multi-select) | — | — |
| Kind | icon + label (`note`/`text`/`frame`/`link`/…) | ✓ | ✓ |
| Text | `title ?? body ?? ref` preview, single line, ellipsis | ✓ | search |
| Type | `note_kind` badge, `—` for non-note kinds | ✓ | ✓ |
| Status | status badge | ✓ | ✓ |
| Importance | must/should/nice/undecided | ✓ | ✓ |
| Updated | relative age | ✓ (default desc) | — |
| | pencil edit icon | — | — |

- Toolbar: free-text search (text column), a filter per filterable
  column, `+ New`, and the bulk bar when ≥1 row is checked.
- Row click sets row focus (highlight) only — it does not open the
  editor and does not toggle the checkbox.
- Sort/filter/search state persists per board in localStorage
  (`veto.easyedit.<ws>/<board>`).

### R2 — Full-page item editor

- Pencil icon (or `Enter`/`e` on the focused row) opens a dedicated item
  page at `?view=edit&item=<id>`. The URL is reloadable/shareable; browser
  Back, the page breadcrumb, and `Esc` return to the list and restore focus
  to the originating row.
- The page uses a Jira-style hierarchy: editable title headline and roomy
  body in the main column; status/type/importance/note status/color in a
  properties rail; tray/board and discard actions; provenance/details.
- Title, body, and link `ref` fields use the shared `DictationField` mic
  affordance. No separate speech implementation exists.
- Editable fields — every user-legitimate mutable field:

| Field | Control |
| --- | --- |
| title, body | text inputs, autosave on 500 ms debounce |
| note_kind (Type) | select — note rows only |
| importance | select |
| status | select limited to `active`/`icebox`/`discarded` (D57: consumed/frozen/shipped are minted by synthesis and ship flows, never by users) |
| note_status | defer/resurface control |
| color | swatch row, `null` = derive from note_kind |
| ref | URL input — link rows only, http/https enforced by the API |
| board | Move to tray action (sets `board: null`) |
| — | Discard action |

- Save model: **autosave-on-change**, identical to canvas — same
  `Saving…/Saved/Not saved/Review conflict` badge states, same
  `expected_updated_at` fence. Text fields debounce; selects, swatches
  and actions write immediately.
- Locked items (`consumed`/`frozen`): pencil becomes a lock with a
  reason tooltip; the same item page still opens **read-only**.
- On 409: reload the row, restore the editor to durable state, toast in
  human language (per the established conflict convention — no silent
  merge).
- Unknown item ids fail closed: show a notice and return to the list.

### R3 — Tray section

- Tray items (`board: null`) render as a collapsible section under the
  board rows, plus a "tray" value in the Kind filter to hide/show them.
- Per-row **Add to board** action: `PATCH /board-items/:id` with
  `board: <slug>, status: 'active'` — the existing `promoteTrayItem`
  path. No position is chosen; the item lands positionless and the
  canvas's deterministic transient layout places it.

### R4 — Bulk operations

- Checkbox column; bulk bar appears when ≥1 row checked.
- Actions: set status, set type (`note_kind`), set importance,
  move to tray, discard.
- All bulk ops are **one atomic OCC-fenced batch write** —
  `PATCH /boards/:board/items` — never N sequential patches.
- Locked rows can't be checked (the API refuses them anyway).
- Destructive ops (discard): undo toast always; additional confirm
  dialog when selection ≥ 10 rows. Undo records into the existing
  session command history (`history.ts`) — undo is a new OCC-fenced
  write, never a local rewind.
- Non-destructive bulk ops fire immediately with a result toast.

### R5 — Create

- `+ New` button, default creates a note on this board
  (`POST /boards/:board/items`); a dropdown offers kind and tray
  destination (tray create goes through `/api/v1/capture`).
- Created items carry no coordinates — transient layout places them on
  the canvas; the new row appears and receives row focus.

### R6 — Keyboard

`j`/`k`/↑/↓ move row focus · `Enter`/`e` open editor · `x` toggle row
checkbox · `/` focus search · `Esc` leave editor / clear selection ·
`?` shortcut hint. All bindings inert while typing in an input.

### R7 — Responsiveness & a11y

- Easy Edit is **fully functional below 900 px** — the narrow-screen
  read-only rule applies to the canvas only. This is the better
  small-screen editing surface.
- Below ~700 px the Type/Importance columns collapse (still editable
  on the item page); the editor stacks its properties rail below content.
- Table semantics (`role="table"` or a real `<table>`), labelled
  headers, `aria-sort` on the active column, live-region toasts,
  focus visible, editor returns focus to the originating row on close.
- SSE refresh (`board_item_updated`) re-reads durable state as today;
  open item pages refresh their row unless a write is in flight.

## Acceptance criteria

| Case | Criteria |
| --- | --- |
| `case:easy-edit-01` | `?view=edit` renders the table with all board items incl. discarded; flag-off boards show no tab |
| `case:easy-edit-02` | Sort by each sortable column; filter by kind/type/status/importance; search narrows by text; state survives reload |
| `case:easy-edit-03` | Full-page editor edits every field in R2; each persists via OCC-fenced write; 409 restores durable + toasts |
| `case:easy-edit-04` | Locked items: read-only item page, lock affordance, server refuses writes |
| `case:easy-edit-05` | Tray section lists tray items, collapses, filters out; Add to board promotes with no coordinate write |
| `case:easy-edit-06` | Bulk status/type/importance/tray/discard = one batch request; ≥10-row discard confirms; undo toast restores |
| `case:easy-edit-07` | `+ New` creates board item (and tray item via dropdown) with no geometry; row appears focused |
| `case:easy-edit-08` | Full keyboard path through R6 without a pointer |
| `case:easy-edit-09` | 375 px width: all functions reachable; editor is a stacked page, never a sheet |
| `case:easy-edit-10` | SSE update from another client refreshes rows; geometry fields never appear in any Easy Edit payload |
| `case:easy-edit-11` | Compact capture expands to the complete shared S-19 form and preserves board/tray destinations |
| `case:easy-edit-12` | `item=<id>` deep-links/reloads; Back/Escape restore the list and originating row focus |
| `case:easy-edit-13` | Landing hierarchy groups compact capture, item tools, dense rows, tray, and distinct empty states |

## Rollout

Ships under `ui.idea_canvas_v2` — no new flag. Rollback = flag off
(classic board) or `?view=idea`. No migrations; the only contract change
is a widened field set on the existing batch-patch endpoint (see
EASY-EDIT-TDD §Contract amendments).
