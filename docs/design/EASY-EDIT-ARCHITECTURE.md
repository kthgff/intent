# Architecture — Easy Edit (non-spatial board view)

Status: proposed 2026-10-10. System-fit guide for `EASY-EDIT-PRD.md` +
`EASY-EDIT-TDD.md`. Explains how the table view composes with the
existing board architecture; it specifies *structure and invariants*,
the TDD specifies the build.

## Context

```text
┌──────────────────────────── IdeaBoard route ───────────────────────────┐
│  data: IdeaBoardDetail   tray: BoardItem[]   handlers: CanvasActions   │
│  mode: 'idea' | 'edit' | 'delivery'                                    │
│                                                                        │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐              │
│  │ BoardCanvas │    │  EasyEdit    │    │ DeliveryView  │              │
│  │ (ReactFlow) │    │  (table)     │    │ (S-01 kanban) │              │
│  └──────┬──────┘    └──────┬───────┘    └───────────────┘              │
│         │                  │                                          │
│         │  same props: data, tray, ws, board, handlers, selection      │
└─────────┼──────────────────┼──────────────────────────────────────────┘
          │                  │
          ▼                  ▼
   PATCH /boards/:b/items (batch, OCC)   PATCH /board-items/:id (single, OCC)
   POST  /boards/:b/items                POST /api/v1/capture
          │                  │
          └─────────┬────────┘
                    ▼
              board_items (Postgres — sole source of truth)
                    ▲
                    │  SSE board_item_updated → reload → re-project
```

Three views, three projections, **one row set**. Easy Edit adds no
store, no event, no entity — it consumes `IdeaBoardDetail` and `tray`
exactly as `BoardCanvas` does.

## State ownership

| State | Owner | Lifetime |
| --- | --- | --- |
| `board_items` rows | server → route `data`/`tray` props | durable |
| statements | route `data.items[].statements` | durable (read-only here) |
| sort/dir/filters/search | `EasyEdit` view state + localStorage | per-board, fail-soft |
| checked ids, focused row | `EasyEdit` view state | session |
| editor item id | `?view=edit&item=<id>` | browser history / shareable |
| undo/redo stacks | route's `CommandHistory` | session |
| save/conflict status | existing toast/badge channel | transient |
| geometry (`x,y,w,h,z_index,zone`) | canvas only — **absent from this view's reads and writes** | — |

The rule that made the canvas safe — *projections never fork durable
state* — is enforced by construction: `table.ts` is pure and every
mutation lands through `handlers`/`client` into the same
`mergeItems`/`load` funnel.

## Write paths (why two endpoints stay two)

```text
single field change          bulk op (N rows)
        │                          │
        ▼                          ▼
PATCH /board-items/:id      PATCH /boards/:board/items
PatchItemBody (broad:        mutations[] × ItemPatch
 board/kind/note_kind/        (widened: geometry + text +
 importance/topic/note_status/ importance/note_kind/
 rationale/ref/zone/serves/    note_status/board:null +
 geo/color/status-subset)      status-subset)
        │                          │
   promoteTrayItem()          transaction: all-or-nothing
   on tray→board              per-row guards:
        │                     consumed/frozen→409
        └────────┬────────    OCC fence→409
                 ▼            zone validity→400
         updateBoardItemExpected()
```

Design consequences:

- **Item editor** uses the single-item route — it already accepts every
  page field (`ref`, `note_status`, `board`) and owns the
  tray-promotion engine call. No backend change needed for R2/R3.
- **Bulk bar** uses the batch route — one atomic write is the product
  requirement, and atomicity only exists inside
  `store.transaction(...)`. Hence the EE-A contract widening.
- **Tray→board is never bulk in v1** — promotion's engine rule lives
  on the single route; the batch route keeps its `item.board ===
  boardSlug` membership check (tray items 404 there). Per-row Add to
  board is the only promote path.
- **Discard** is `status:'discarded'` — expressible in both schemas;
  bulk discard rides the batch route.

## Concurrency model

Unchanged invariants, applied to a second client surface:

- Every write carries `expected_updated_at` from the row the user last
  saw; SSE refresh (`board_item_updated` → `load`) is the convergence
  mechanism.
- Batch write = one transaction: guards run per mutation, all succeed
  or the request 4xx/409s with nothing applied. Partial bulk success
  is impossible by construction.
- Easy Edit's extra exposure vs. canvas: **SSE during item editing**.
  A remote touch bumps `updated_at`; the next debounced write 409s and
  the item page restores durable state + toasts (same contract as the
  canvas's `ConflictNotice`, lighter-weight because the draft is a
  form, not canvas text).
- Undo commands fence on recorded `fromTs` values (`history.ts`
  `planFor`), so undo-after-remote-edit degrades to a conflict toast,
  never a silent clobber. The only change: `makeCommand` accepts a
  field list so Easy Edit commands record semantic fields
  (`note_kind`, `importance`, `note_status`, `board`) the canvas set
  doesn't include. `PATCHABLE_FIELDS` and existing canvas behavior are
  untouched.

## Component boundaries

| Module | Knows | Must not know |
| --- | --- | --- |
| `table.ts` | `BoardItem` shape; sort/filter semantics | React, network, geometry |
| `EasyEdit.tsx` | rows, view state, which handler to call | SQL, OCC wire format |
| `ItemEditorPage.tsx` | one `BoardItem`, field→patch mapping | list state, other items |
| `IdeaBoard.tsx` | mode, handlers, merge/load | presentation details |
| `board.ts` (api) | schema + guards + transaction | which UI sent the mutation |

The reusable vocabulary — `noteKindMeta`, `isConsumedItem`,
`canvasColor`, `StatusBadge`, `fmtAge`, and multibar chrome — comes
from `discovery.ts`, `components`, and the canvas chrome layer; nothing
is re-implemented.

## Invariants (restated as enforcement points)

1. **Geometry never crosses the view** — `projectRows` doesn't read
   it; no form field emits it; the batch schema doesn't add it (it was
   already there for canvas — the view simply never sends it).
2. **Consumed/frozen is server-enforced** — 409 in both routes; UI
   lock is affordance only.
3. **Status writes are user-legitimate only** — `active|icebox|
   discarded` in both schemas; consumed/frozen/shipped are minted by
   synthesis/ship flows (D57).
4. **Tray→board goes through the engine** — `promoteTrayItem`, never a
   bare `board:` column update (single route already enforces this).
5. **No silent merge on conflict** — 409 → reload → restore → human
   toast. Consistent across canvas, inspector, item page, bulk bar.
6. **Secrets/SSRF** — `ref` URLs validated http/https server-side;
   `ref` is deliberately not in the batch schema.

## Failure modes

| Failure | Behavior |
| --- | --- |
| stale single write | 409 → item page reloads row, toast |
| stale member in bulk | batch 409 (nothing applied) → toast names conflict → reload |
| item deleted remotely while editor open | next write 404s → editor closes → row gone after reload → toast |
| localStorage view-state corrupt | guarded parse → defaults |
| `?view=` garbage | ignored → `idea` |
| SSE floods during bulk | `load` is idempotent; in-flight PATCH unaffected (server fence decides) |

## Relationship to existing surfaces

- **ObjectsPanel** (canvas overlay): stays — it's an in-canvas
  locator. Easy Edit is the grown-up editing surface; the panel can
  later link "open in Easy Edit" if desired (deferred).
- **BoardInspector**: read-first semantic detail (provenance,
  statements, produced artifacts). ItemEditorPage is a roomy write-first
  page. They share field vocabulary, not a panel shell.
- **ClassicBoard**: flag-off path; Easy Edit never renders there.

## Sizing

Backend: ~40 lines of zod + ~15 lines of guard + tests. UI: the table and
item-page components, one pure module (~150), query wiring,
styles (~150). No migrations, no new dependencies, no new routes.
