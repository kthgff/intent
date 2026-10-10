# TDD — EASY-EDIT-01: non-spatial board-object table

Status: proposed 2026-10-10. This document adds a third board view
("Easy Edit") without changing Veto's product model. `PRD.md` §15.3,
`ARCHITECTURE.md`, `API.md`, `SCHEMAS.md`, and `DB-SCHEMA.md` remain
authoritative; the contract amendments named here must land with the
implementation. Requirements are enumerated in `EASY-EDIT-PRD.md`.

## Architecture

### Outcome

`IdeaBoard` gains a third mode — `Idea | Easy Edit | Delivery` — where
the same `board_items` rows render as a dense, sortable, filterable
table instead of spatial nodes. Every user-legitimate mutable field is
editable from a full-page item editor; multi-select drives atomic bulk
operations; tray items are a first-class section with one-click
promotion. The view is a **projection over durable state** — it holds
no copy of item data and issues no new write paths beyond one widened
contract on the existing batch endpoint.

### Component topology

`IdeaBoard.tsx` stays the route-level coordinator: it owns loading,
mode selection, tray data, selection id, the mutation handlers, and the
toast channel. Easy Edit is a sibling of `BoardCanvas`, consuming the
same `data`, `tray`, `handlers`, and `ws/board` props — it never mounts
React Flow.

```text
IdeaBoardRoute                     (coordinator — unchanged role)
├── canvas-topbar
│   ├── identity + lifecycle
│   ├── Idea / Easy Edit / Delivery mode
│   └── Synthesize + board actions
├── mode === 'idea'  → BoardCanvasProvider (+ Inspector)   [existing]
├── mode === 'edit'  → EasyEdit                            [new]
│   ├── EditToolbar    (search, filters, +New, bulk bar)
│   ├── ObjectsTable   (board rows — sortable, filterable)
│   ├── TraySection    (collapsible; per-row Add to board)
│   └── ItemEditorPage (URL-addressed write surface)
└── mode === 'delivery' → DeliveryView                     [existing]
```

New files live in `packages/ui/src/board-canvas/` — the feature shares
the canvas's model helpers (`noteKindMeta`, `isConsumedItem`,
`canvasColor`), its history machinery, and its chrome vocabulary.

### Durable and transient state

Same rule as the canvas: `data.items` (`{item, statements}[]` from
`GET /boards/:board`) and `tray` are the only item state. Table
projection is pure — rows are derived per render from durable rows plus
**view state** (sort key, filters, search text, checked ids, focused
row id, editor item id). View state is session-local; sort/filters
persist to localStorage under `veto.easyedit.<ws>/<board>`.

Differences from the canvas projection, deliberate:

- **Discarded items are shown** (muted). `projectItems()` filters them
  out for spatial rendering; the audit surface must not hide them.
- **Geometry is never read** — rows project `id`, `kind`, `note_kind`,
  `title`, `body`, `ref`, `status`, `importance`, `note_status`,
  `color`, `board`, `updated_at`, `consumed_by`, `provenance`.
- `statements` arrays are already on the surface rows; the table shows
  no statement column and the item page does not edit them.

### Row contract

```ts
// packages/ui/src/board-canvas/table.ts — pure, unit-tested
export interface TableRow {
  item: BoardItem;
  locked: boolean;            // consumed | frozen
  section: 'board' | 'tray';
}
export type SortKey =
  | 'kind' | 'text' | 'note_kind' | 'status' | 'importance' | 'updated_at';
export interface ViewFilter {
  search: string;
  kind: BoardItem['kind'] | 'tray' | null;   // 'tray' = tray-only view
  note_kind: string | null;
  status: BoardItem['status'] | null;
  importance: string | null;
  showTray: boolean;
}
export function projectRows(
  surfaces: SurfaceLike[],
  tray: BoardItem[],
): TableRow[]
export function applyView(rows: TableRow[], f: ViewFilter,
  sort: SortKey, dir: 'asc' | 'desc'): TableRow[]
```

Sort order per key is deterministic: primary key, then
`title ?? body ?? id`, then `id` — no unstable sorts on refresh.

### Contract amendments

One amendment — **widen the batch-patch field set**. This is the only
backend change; no new routes, no schema/migration changes.

Today `PATCH /api/v1/boards/:board/items` validates each mutation's
`patch` against `GeometryPatch` (`x,y,w,h,zone,color,z_index,title,
body,status`). Easy Edit bulk ops need three more field groups:

| Field | Add | Constraint |
| --- | --- | --- |
| `note_kind` | `enumOf(NOTE_KINDS).nullable().optional()` | applies to any row; harmless on non-note kinds (column is already generic) |
| `importance` | `enumOf(NOTE_IMPORTANCES).nullable().optional()` | — |
| `note_status` | `enumOf(NOTE_STATUSES).optional()` | defer/resurface batch ops |
| `board` | `z.literal(null)` **or** `z.literal(boardSlug)` | `null` = move to tray; a *different* slug is a cross-board move — **rejected 400** in v1 |

Guards unchanged and still enforced per mutation: item must belong to
`boardSlug` (tray items still 404 — tray→board stays single-item via
`promoteTrayItem`), consumed/frozen → 409, `expected_updated_at`
mismatch → 409, `status` stays limited to `active|icebox|discarded`.
`assertCanvasItemKind`/`assertCanvasItemRef` unaffected (no `kind`/`ref`
in the batch patch — link URLs are item-page-only via the single route).

`history.ts` — `ItemPatch` widens to the same field set and
`makeCommand` gains an optional field-list parameter
(`fields = PATCHABLE_FIELDS`) so Easy Edit commands record
`note_kind`/`importance`/`note_status`/`board` without geometry
commands inheriting fields they never touch. `PATCHABLE_FIELDS` itself
is unchanged.

`api.ts` — `patchBoardItems` body type widens to match.

### REST surface

| Verb | Route | Use |
| --- | --- | --- |
| GET | `/api/v1/boards/:board?workspace=` | existing — items + surfaces |
| GET | `/api/v1/tray?workspace=` | existing — tray section |
| POST | `/api/v1/boards/:board/items` | existing — `+ New` (board) |
| POST | `/api/v1/capture` | existing — `+ New` → tray |
| PATCH | `/api/v1/boards/:board/items` | **widened** — bulk ops; the item page writes via the single route |
| PATCH | `/api/v1/board-items/:id` | existing — all item-page edits, tray promotion (`board`, `status`) |

SSE: unchanged — `board_item_updated` notifications drive
`useBoardItemRefresh(load)`; the table re-projects.

### Interaction model

- **Write path**: item-page fields → single-item PATCH with
  `expected_updated_at` → merge returned row into `data.items`. Text
  inputs debounce 500 ms; every other control writes on change.
- **Bulk path**: checked ids → one batch PATCH → merge returned rows.
  On 409 the whole batch fails closed (server-side transaction);
  surface the conflicting id in the toast and reload.
- **Conflict**: a stale write returns 409 → reload the item, restore
  editor/row state to durable, toast `Couldn't save changes: …`. No
  silent merge — same contract as canvas/inspector.
- **Undo**: bulk ops and destructive single ops push a
  `BoardCommand` (label like `discard 12 items`) into the route's
  existing `CommandHistory`; the undo toast triggers `planUndo` +
  batch write + `commitUndo`. Conflicts report per the existing
  history convention.
- **Discard confirm**: `selected.size >= 10` gates a confirm dialog
  naming the count; below that the undo toast is sufficient.
- **Row focus** is visual + keyboard state only — `tabIndex` roving on
  rows; it never marks durable state.
- **+ New**: `kind` and destination chosen on the button's dropdown;
  `note`/`board` is the single-click default. No coordinates are ever
  sent.

### View-state persistence

localStorage, per board, fail-soft:

```ts
key = `veto.easyedit.${ws}/${board}`
{ sort: SortKey, dir, filters: ViewFilter }   // JSON, guarded parse
```

`?view=edit` selects the mode on load; `?view=` values other than
`idea|edit|delivery` are ignored (fail to default `idea`).

### Visual system

- New `/* ---- EASY-EDIT` block in `styles.css` rides the application theme
  tokens (`--bg`, `--surface-*`, `--text`, `--border-*`, `--accent`). Easy
  Edit is an application work surface and never inherits the spatial canvas's
  always-white paper tokens. The topbar becomes a full-width themed app bar in
  this mode while the Idea view keeps its floating canvas chrome.
- Rows use a comfortable 44 px target with single-line cells,
  `text-overflow: ellipsis`, and no mono `id` — ids stay in the item-page
  details. The table, grouped tools, and compact capture affordance sit on
  elevated theme surfaces with explicit hover, keyboard-focus, and selected
  states.
- Reuse: `noteKindMeta` icon/label, `StatusBadge`, color dot using the
  `canvasColor()` resolution, `canvas-icon-button` for the pencil, and
  `canvas-multibar` pattern for the bulk bar.
- Item editor: a dedicated `?view=edit&item=<id>` page with headline/body
  main column and properties rail. Under 900 px the rail stacks below the
  content; `Esc`/Back clear the item parameter and return focus to the
  originating row.
- Muted rows for `discarded`; lock icon + reason tooltip replaces the
  pencil on `consumed`/`frozen`.

### Accessibility and responsive behavior

- Real `<table>` semantics; `aria-sort` on the active `<th>`;
  checkboxes labelled `Select <title>`; bulk bar is a `role="toolbar"`.
- Keyboard map (R6): row focus via `j`/`k`/↑/↓, `Enter`/`e` editor,
  `x` check, `/` search, `Esc` out, `?` hint popover.
- All pointer actions keyboard-reachable (per the screens
  convention); the table is the board's primary non-spatial editing
  path — the ObjectsPanel remains the canvas's in-canvas locator.
- Below 900 px: fully functional (the canvas read-only rule does not
  apply); columns collapse by priority — Kind+Text+Status always
  visible, Type/Importance/Updated hide progressively; the editor remains a
  stacked page. Below 700 px the app bar becomes two rows, the mode control
  spans the available width, and search/filters reflow without horizontal
  page scrolling.
- `prefers-reduced-motion`: editor/section transitions instant.

### Performance budget

- Projection is O(n log n) sort + O(n) filter over ≤ few thousand rows
  — no virtualization needed at board scale; cap rendered rows at 500
  with a "showing N of M" footer beyond that (deferred: real
  virtualization).
- Debounced search (150 ms); no network on sort/filter (client-side).
- Item-page writes ≤ 1 in-flight PATCH per field change; bulk ≤ 1 batch.

## Execution plan

| WP | Scope | Key files |
| --- | --- | --- |
| EE-A | Contract: widen `GeometryPatch`→`ItemPatch` (4 fields + guard), `api.ts` types, `history.ts` field-list param, API tests | `packages/api/src/board.ts`, `packages/ui/src/api.ts`, `packages/ui/src/board-canvas/history.ts`, `packages/api/test/board.test.ts` |
| EE-B | Table core: `table.ts` projection + `EasyEdit.tsx` shell (toolbar/table/tray section, sort/filter/search/persist) | `packages/ui/src/board-canvas/table.ts`, `EasyEdit.tsx`, `IdeaBoard.tsx`, `styles.css` |
| EE-C | Full-page item editor + single-row writes + lock/conflict handling | `ItemEditorPage.tsx`, `EasyEdit.tsx` |
| EE-D | Multi-select bulk ops + undo integration + discard confirm | `EasyEdit.tsx`, `history.ts` (param), `IdeaBoard.tsx` handlers |
| EE-E | Keyboard, a11y, small-screen, `?view=`, polish + tests | as above + `packages/ui/test/easy-edit.test.tsx` |

Sequenced A→E; A lands first since B–D write against the widened
contract (per the parallel-agent rule, contracts before surfaces).

## File plan

| Path | Change |
| --- | --- |
| `packages/api/src/board.ts` | widen batch `patch` schema; `board` field guard (null or same-slug); no route-shape changes |
| `packages/api/test/board.test.ts` | batch semantic-field + board-null + cross-board-reject + fence cases |
| `packages/ui/src/api.ts` | `patchBoardItems` mutation patch type |
| `packages/ui/src/board-canvas/table.ts` | **new** — row projection + sort/filter (pure) |
| `packages/ui/src/board-canvas/EasyEdit.tsx` | **new** — view shell, toolbar, table, tray section, bulk bar |
| `packages/ui/src/board-canvas/ItemEditorPage.tsx` | **new** — URL-addressed write-first page |
| `packages/ui/src/board-canvas/history.ts` | field-list param on `makeCommand`; `ItemPatch` widen |
| `packages/ui/src/screens/IdeaBoard.tsx` | third mode, `?view=`/`item=` query state, item/tray handlers, create |
| `packages/ui/src/styles.css` | EASY-EDIT block |
| `packages/ui/test/easy-edit.test.tsx` | projection + interaction tests |
| `docs/API.md` | batch-patch field row update |
| `docs/TRACKER.md` | decision-log entry |

## Risks / open items

- **Kind conversion** stays out of v1 (link↔note↔zone invariants);
  revisit if users ask — the single-item route already permits it.
- **Cross-board moves**: `board` accepts only `null` (tray) in batch;
  single-item PATCH still allows board→board — the item page offers only
  Move-to-tray to keep one mental model.
- **`topic`/`rationale`/`applies_to`/`serves`** are mutable via the
  single route but not on the item page v1 (PRD non-goals: they're
  evidence/provenance-adjacent); page additions can land later.
- **Statement editing** deliberately absent — inspector owns
  confirm/dispute/correct; duplicating it here splits the model.
- **500-row cap** is a display guard, not a hard limit — boards at
  that scale need virtualization (deferred).
- The item page and inspector intentionally have different spatial roles:
  full-page write surface versus canvas-side read-first detail.

## Threat model

- Batch `board` field is constrained to `null`/same-slug server-side —
  a crafted cross-board mutation 400s rather than smuggling items
  between boards.
- Semantic enum fields are `enumOf(...)` validated server-side; the UI
  never trusts its own option lists.
- `expected_updated_at` remains mandatory per mutation — no unfenced
  bulk write path is added.
- consumed/frozen immutability is enforced server-side per mutation;
  the UI lock is cosmetic only.
- No geometry keys are added to the widened schema — Easy Edit clients
  can't move items even accidentally (geometry keys were already
  accepted for the canvas; the view simply never sends them).
- `ref`/URL fields stay off the batch route entirely — SSRF guard
  surface unchanged.

## Addenda

- Deferred: column customization, connector columns/tables, real
  virtualization, `kind` conversion UI, bulk defer/resurface,
  server-side persisted view preferences, table→canvas "reveal on
  canvas" handoff (locate already exists via ObjectsPanel).
