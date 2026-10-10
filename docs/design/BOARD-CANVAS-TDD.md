# TDD — BOARD-CANVAS-01: Miro-inspired Veto idea canvas

Status: proposed 2026-10-06. This document refines S-16 without changing
Veto's product model. `PRD.md`, `ARCHITECTURE.md`, `API.md`, `SCHEMAS.md`,
and `DB-SCHEMA.md` remain authoritative; the contract amendments named here
must land with the implementation.

## Architecture

### Outcome

Replace the current lane-based idea-board renderer with a desktop-first,
spatial canvas that feels familiar to Miro users while remaining recognizably
**Veto**. The first release provides:

- infinite pan/zoom and exact spatial placement;
- typed sticky notes, free text, zones/frames, connectors, links, and images;
- drag, resize, marquee/multi-select, duplicate, delete, undo, and redo;
- a left creation rail, selected-object floating toolbar, right semantic
  inspector, bottom tray, and bottom-right zoom controls;
- type-derived default sticky colors with user-overridable colors;
- deterministic, non-destructive placement of legacy unpositioned items;
- per-mutation autosave, optimistic concurrency, live remote refresh, and
  explicit conflict recovery;
- light and dark canvas themes, keyboard access, reduced motion, and a
  simplified small-screen read view.

Live cursors, simultaneous pointer-level co-editing, comments, tables, task
cards, voice notes, presentation mode, and mobile editing are out of scope.

### Screenshot review and design translation

The reference succeeds because the canvas dominates and application chrome is
broken into compact floating islands. The useful patterns are:

1. A large, quiet, low-contrast work surface with no content-column boundary.
2. Board identity in a compact top-left header rather than a full page banner.
3. A vertical creation rail placed at the user's point of work.
4. Direct manipulation with visible selection handles.
5. A contextual toolbar beside the selection instead of a distant form.
6. Persistent zoom/help controls in a predictable corner.
7. Mixed object sizes and frames that let position communicate meaning.
8. Soft elevation, restrained borders, and high-contrast content objects.

Veto should adopt those interaction and hierarchy patterns, not Miro's logo,
brand blue, exact icons, avatars, sharing chrome, or pixel measurements. Veto's
Inter/JetBrains Mono typography, semantic status language, provenance, and
governed Synthesize workflow remain its identity.

### Component topology

`IdeaBoard.tsx` becomes a route-level coordinator instead of the canvas
renderer. It owns loading, mode selection, tray data, and the selected item id.
The spatial surface lives behind a `ReactFlowProvider` and uses React Flow 12,
as required by `ARCHITECTURE.md`.

```text
IdeaBoardRoute
├── BoardTopbar
│   ├── identity + lifecycle
│   ├── Idea / Delivery mode
│   └── Synthesize + board actions
├── BoardCanvasProvider
│   ├── BoardCanvas (ReactFlow)
│   │   ├── StickyNode
│   │   ├── TextNode
│   │   ├── ZoneNode
│   │   ├── LinkNode
│   │   ├── ImageNode
│   │   └── ConnectorEdge
│   ├── BoardToolRail
│   ├── SelectionToolbar
│   ├── BoardInspector
│   ├── CanvasControls
│   └── CaptureTrayDock
└── DeliveryView
```

The canvas library handles viewport transforms, hit testing, selection,
node dragging/resizing, and edge gestures. Veto custom components own all
content, semantics, persistence, keyboard behavior, and accessibility.

### Durable and transient state

Durable shared state comes only from the REST board projection:

- item content, taxonomy, lifecycle, geometry, explicit color, zone, and
  stacking order;
- connector endpoints, label, lifecycle, and update fence;
- image asset metadata;
- board lifecycle and extracted statements.

Transient local state includes:

- viewport position/zoom, saved per user/device under a workspace-qualified
  local-storage key;
- current selection, lasso, open popovers, draft text, and drag preview;
- the bounded in-session undo/redo command stack;
- optimistic positions between pointer movement and the committed write.

React Flow's node/edge arrays are projections, not a second source of truth.
Server responses replace optimistic records after every committed mutation.

### Canvas object contract

| Canvas object | Durable representation | Default size | Editing behavior |
| --- | --- | --- | --- |
| Typed sticky | `board_items.kind=note` | 220×180 | double-click edits text; type sets initial color; color may be overridden |
| Free text | `board_items.kind=text` | 280×80 | transparent node; auto-height then resizeable width |
| Zone/frame | `board_items.kind=zone` | 720×480 | titled, resizeable, behind children; membership writes the child `zone` id |
| Link | `board_items.kind=link`, URL in `ref` | 320×120 | validates `http`/`https`; opens through the safe shell/browser path |
| Image | `board_items.kind=image`, asset id in `ref` | intrinsic, max 480 px | authenticated asset render; caption in `body` |
| Connector | `board_connectors` row | n/a | source/target handles; optional label; no domain authority by itself |

`serves` remains the canonical goal relationship and must not be overloaded to
store drawn connectors. A connector is a discovery/topology hint until a
governed action explicitly creates a typed domain relation.

### Contract amendments

The implementation requires a core-contract work package because the current
closed item-kind enum does not contain `text`, `image`, or `link`, and the data
model cannot persist color overrides, stacking, connectors, or image assets.

1. Extend `BOARD_ITEM_KINDS` with `text`, `image`, and `link`.
2. Add nullable `color` (`yellow|pink|blue|green|orange|purple|gray`) and
   integer `z_index` to `BoardItemSchema` and `board_items`.
3. Define `BoardConnectorSchema` and `BoardAssetSchema` in `@veto/core`.
4. Add `board_connectors` with workspace/board-qualified source and target,
   label, status (`active|superseded`), and `created_at`/`updated_at`.
5. Add `board_assets` with owning item, MIME type, byte size, SHA-256,
   app-managed storage key, original filename, and creation time. File bytes
   remain outside Postgres in the app-managed data directory.
6. Specify that `board_items.zone`, when newly written, contains a zone item id.
   Legacy labels remain readable and are converted only by an explicit user
   move into a real frame.

Unknown kinds, colors, MIME types, connector statuses, malformed URLs, and
non-finite or out-of-range geometry fail closed at the API boundary.

### REST surface

Keep the existing single-item endpoints for inspector edits and add operations
needed for direct manipulation:

| Path | Contract |
| --- | --- |
| `GET /boards/:board` | Existing payload plus `connectors`; items carry `color` and `z_index` |
| `PATCH /boards/:board/items` | Atomic batch `{workspace, mutations:[{id, expected_updated_at, patch}]}`; all succeed or none do |
| `POST /boards/:board/connectors` | Create a validated source→target connector between active items on the same board |
| `PATCH /boards/:board/connectors/:id` | OCC-fenced label/end-point update |
| `DELETE /boards/:board/connectors/:id` | Supersede connector; no hard delete after it is used by synthesis |
| `POST /boards/:board/assets/images` | Authenticated multipart image upload; returns asset + created image item |
| `GET /board-assets/:id` | Authenticated image bytes with immutable digest ETag and safe content headers |

The batch endpoint is required for multi-node drag, align/distribute, zone
membership, and undo. The transaction validates every item before writing so a
stale or immutable member returns `409` without partially moving the selection.
The SSE hub emits one `board_item_updated` notification after commit; other
clients re-read the durable board projection.

Geometry limits are explicit: coordinates must be finite and within a broad
canvas envelope; width/height must be positive and capped. Uploads accept only
decoded PNG, JPEG, WebP, or non-animated GIF up to a configured byte and pixel
limit. SVG is excluded from the first release.

### Interaction model

- **Pointer:** click selects; shift-click adds; drag empty space pans; marquee
  selects; wheel scrolls; command/control-wheel zooms; drag handles connect.
- **Creation:** click a rail tool then click the canvas; double-click empty
  canvas creates a typed sticky; pasted text creates a sticky and pasted image
  data creates an image after upload confirmation.
- **Editing:** Enter or double-click edits the primary text. Escape commits a
  valid draft or cancels an unchanged draft. Common formatting/color/type
  controls appear in the selection toolbar; provenance, statements,
  importance, lifecycle, and source data live in the right inspector.
- **Zones:** dropping an active object into a frame writes its zone id. Moving a
  zone moves its selected active children in one atomic batch. Consumed/frozen
  objects never move or resize.
- **Arrange:** “Arrange by type/status/zone” previews a deterministic layout and
  applies it only after confirmation. It is one undoable batch operation.
- **Delete:** canvas deletion patches an active item to `discarded` and hides it
  from the normal projection; it does not call the hard-delete cleanup route.
  Undo restores the prior status, and an optional “Show removed” view preserves
  auditability. Associated image bytes remain retained while referenced.
- **Undo/redo:** session-local command history stores the last successful
  before/after server records. Undo is a new OCC-fenced mutation, not a local
  rewind; a remote edit that invalidates the fence stops undo and explains why.
- **Autosave:** text commits after 500 ms idle or blur; geometry commits at
  pointer-up; color/type/actions commit immediately. Saving/saved/error is
  visible but never blocks continued panning.
- **Conflicts:** `409` restores the server record, keeps the user's attempted
  text in a recoverable draft where applicable, and offers Review changes or
  Retry. The client never silently merges semantic content.

### Legacy layout

Items whose `x` or `y` is null receive a deterministic projected position,
sorted by stable id and grouped first by valid zone, then note type. Existing
positioned items are never moved. Virtual legacy groups are visually labelled
but are not written as zone items. Projected positions remain client-only until
the user moves the item or explicitly accepts Arrange; simply opening a board
must produce zero writes.

### Visual system

Light theme uses a soft neutral canvas (`#f3f4f6`) with subtle dot grid, white
floating chrome, dark ink, 1 px neutral borders, and restrained shadows. Dark
theme uses the existing warm-dark paper direction with adjusted accessible
sticky colors. The visual acceptance baseline is:

- canvas fills the available shell width and height;
- topbar, tool rail, selection toolbar, and zoom controls float above it;
- controls use Veto typography, Lucide icons, radii, focus rings, and semantic
  status labels;
- stickies remain legible at 75–150% zoom and display their authoritative type
  chip even when their color is overridden;
- provenance and lifecycle are communicated by label/icon as well as color;
- selected nodes have a two-pixel focus outline and resize handles;
- consumed/frozen nodes are dimmed, locked, and link to produced artifacts;
- shipped nodes use a restrained Veto success accent, not a decorative glow.

Exact Miro brand assets, avatars, sharing controls, confetti, and the reference
screenshot's logo/navigation are prohibited from the acceptance baseline.

### Accessibility and responsive behavior

- Every tool and icon button has an accessible name and tooltip.
- The tool rail and object actions are operable by keyboard; Tab reaches canvas
  overlays, arrow keys move a selected active object by 1 px, Shift+arrow by
  10 px, and Delete asks for confirmation when data loss is material.
- An off-canvas “Board objects” list mirrors objects in reading order and lets a
  keyboard or screen-reader user select, edit, and locate any item.
- Status, type, provenance, and save state never rely on color alone.
- Focus is restored to the canvas after creation and to a stable neighbor after
  deletion. Toasts use a polite live region; conflicts use an assertive one.
- Reduced-motion disables animated viewport fitting and node transitions.
- At widths below 900 px, editing tools collapse and the board becomes a
  simplified pan/zoom/read surface with an Open inspector action. Mobile
  creation continues through Quick Capture rather than the full canvas.

### Performance budget

- Interactive target: 60 fps pan/zoom and drag on the reference board of 300
  simple nodes, 40 zones, 300 connectors, and 20 images on supported desktop
  hardware.
- Initial usable canvas: under 1.5 seconds after the board JSON is available for
  300 nodes; image decoding is lazy and never blocks node rendering.
- Only visible/near-visible rich node bodies render fully; distant nodes use a
  compact representation. Inspector statement data already present in the
  projection is not duplicated into every React Flow node object.
- Geometry writes are coalesced per pointer gesture, never per pointer event.
- Board refresh preserves viewport and selection when their ids still exist.

## Execution plan

| step | description | verify-with |
| --- | --- | --- |
| 1 | Ratify contract amendments in core and binding docs; add board item color/z-order plus connector and asset schemas | core schema/unit tests; `pnpm typecheck` |
| 2 | Add numbered Postgres migration, Store methods, transactions, mapping, and contract tests | store migration + contract tests against PGlite/Postgres |
| 3 | Extend strict board APIs with batch mutation, connector CRUD, safe image upload/read, and one post-commit live event | Fastify injection tests including invalid/stale/atomic cases |
| 4 | Add React Flow and build pure projection, legacy layout, semantic color, command-history, and geometry helpers | UI unit tests; `pnpm --filter @veto/ui typecheck` |
| 5 | Build custom nodes/edge, canvas, overlays, keyboard model, inspector integration, autosave, and conflict recovery | Testing Library interaction tests |
| 6 | Replace lane rendering in `IdeaBoard`, retain Delivery mode and tray, and connect selection scope to the Synthesize entry point when its launch API is available | route/component tests and manual workflow pass |
| 7 | Add light/dark polish, responsive read mode, accessibility checks, performance fixtures, and Playwright visual baselines | Playwright workflow/visual tests; axe/manual keyboard pass |
| 8 | Roll out behind `ui.idea_canvas_v2`, migrate no data eagerly, observe conflicts/upload failures, then remove the old lane renderer after acceptance | full build/verify suite and staged dogfood checklist |

## File plan

The split below is the expected implementation boundary; exact migration and
work-package numbers are allocated when the plan is ticketed.

| file | repo | change | why |
| --- | --- | --- | --- |
| `docs/PRD.md` | veto | Clarify hybrid sticky color and first-release object scope | Backport the ratified product decision |
| `docs/ARCHITECTURE.md` | veto | Reference this React Flow composition and asset boundary | Keep the binding architecture aligned |
| `docs/API.md` | veto | Add batch, connector, and asset contracts | Bind new external behavior |
| `docs/DB-SCHEMA.md` | veto | Add fields/tables and invariants | Bind persistence changes |
| `docs/SETTINGS.md` | veto | Add the temporary canvas rollout flag | Make rollout behavior explicit |
| `docs/design/s-16-board-canvas.md` | veto | Replace outdated tldraw note and link this TDD | Keep the screen contract consistent |
| `packages/core/src/enums.ts` | veto | Extend object kinds and add color/connector enums | Closed taxonomy must fail closed |
| `packages/core/src/schemas.ts` | veto | Add fields and connector/asset schemas | Shared wire/storage contract |
| `packages/core/src/store.ts` | veto | Add asset, connector, and atomic batch interfaces | Contract-layer persistence boundary |
| `packages/core/src/config.ts` | veto | Add `ui.idea_canvas_v2` rollout flag | Typed rollout control |
| `packages/core/test/schemas.test.ts` | veto | Validate accepted/rejected canvas contracts | Prevent taxonomy/schema drift |
| `packages/config/src/validate.ts` | veto | Permit the new strict UI key | Config must fail closed on unknown keys |
| `packages/config/test/config.test.ts` | veto | Cover default/explicit rollout flag | Prevent settings drift |
| `packages/store/migrations/pg/NNNN_board_canvas.sql` | veto | Persist canvas fields, connectors, and assets | Durable data model |
| `packages/store/src/pg.ts` | veto | Implement mappings and atomic operations | Postgres implementation |
| `packages/store/test/contracts-v3.test.ts` | veto | Add geometry/connector/asset/OCC contract cases | Verify store semantics |
| `packages/api/src/board.ts` | veto | Add strict board-canvas routes | HTTP boundary |
| `packages/api/test/board.test.ts` | veto | Cover CRUD, validation, atomicity, uploads, and events | API regression coverage |
| `packages/cli/src/paths.ts` | veto | Derive the board-asset directory under Veto's data root | Keep file storage scoped and deterministic |
| `packages/cli/src/commands/daemon.ts` | veto | Create/pass the asset root to the API | Make the filesystem trust boundary explicit |
| `packages/cli/test/deps.test.ts` | veto | Verify asset-root derivation and startup failure | Prevent unsafe fallback paths |
| `packages/ui/package.json` | veto | Add `@xyflow/react` 12 | Binding canvas implementation |
| `packages/ui/src/api.ts` | veto | Add canvas payloads and mutations | Typed UI client |
| `packages/ui/src/board-canvas/model.ts` | veto | Project durable rows to nodes/edges | Single deterministic adapter |
| `packages/ui/src/board-canvas/layout.ts` | veto | Legacy and arrange layouts | Pure, testable placement |
| `packages/ui/src/board-canvas/history.ts` | veto | OCC-aware command history | Undo/redo semantics |
| `packages/ui/src/board-canvas/BoardCanvas.tsx` | veto | React Flow surface and persistence bridge | Main interaction layer |
| `packages/ui/src/board-canvas/nodes.tsx` | veto | Veto custom node renderers | Object-specific behavior |
| `packages/ui/src/board-canvas/ConnectorEdge.tsx` | veto | Custom connector rendering/editing | Relationship hint surface |
| `packages/ui/src/board-canvas/overlays.tsx` | veto | Topbar, rail, toolbar, controls, tray | Miro-inspired low-chrome layout |
| `packages/ui/src/board-canvas/Inspector.tsx` | veto | Taxonomy, provenance, statements, lifecycle | Advanced governed controls |
| `packages/ui/src/screens/IdeaBoard.tsx` | veto | Route coordination; remove lane renderer | Activate the new canvas |
| `packages/ui/src/discovery.ts` | veto | Retire grouping as renderer; retain taxonomy helpers | Grouping becomes optional arrange |
| `packages/ui/src/styles.css` | veto | Theme tokens, canvas overlays, nodes, responsive mode | Veto-branded visual system |
| `packages/ui/test/board-canvas.test.ts` | veto | Projection/layout/history unit cases | Deterministic behavior coverage |
| `packages/ui/test/idea-board.test.tsx` | veto | Creation, selection, editing, autosave, conflict tests | Component behavior coverage |
| `packages/ui/test/board-canvas.e2e.ts` | veto | Pointer/keyboard/theme/read-mode workflows and screenshots | End-to-end visual acceptance |

## Risks / open items

- React Flow's accessibility support does not replace the off-canvas object
  list; omitting that list would make spatial objects inaccessible.
- Hundreds of statement-rich items can inflate the existing board projection.
  If measurement breaches the budget, split statement details into the existing
  per-item endpoint while retaining counts in the board payload.
- Image storage location and quota need a settings contract before upload ships;
  storage must derive from Veto's existing app-data root and startup must fail
  closed if that root cannot be created. The implementation must not invent an
  unrelated home-directory path.
- The Synthesize launch API is not currently exposed by the idea-board UI. The
  canvas can supply board/selection/zone ids, but synthesis orchestration should
  be ticketed as a dependency rather than mocked in the client.
- React Flow nested-node behavior must be proven with a zone prototype before
  committing to child constraints; zone membership remains a durable Veto
  field even if the rendering technique changes.
- Visual regression screenshots are platform-sensitive. Pin viewport, theme,
  fonts, fixtures, and animation settings before accepting baselines.

## Threat model

Assets at risk are local files, authentication tokens, board evidence, and the
ability to open external destinations. Trust boundaries are multipart uploads,
stored image bytes, user-entered URLs, and remote board updates.

- Decode and verify image bytes; never trust filename extension or client MIME.
- Generate storage keys server-side, keep them under one explicit data root,
  and prevent path traversal and overwrite.
- Serve assets only through authenticated ids with `nosniff`, a fixed safe
  content type, digest ETag, and restrictive content-security policy.
- Permit only `http:` and `https:` links. Use `noopener,noreferrer`; the desktop
  shell applies its narrow external-open capability.
- Do not fetch link metadata in this release, avoiding a new SSRF surface.
- Preserve OCC and consumed/frozen immutability on batch writes and connector
  mutations. Client selection is never authority.
- Avoid logging image contents, local paths, URLs containing credentials, or
  authentication headers.

## Addenda

| ts | planned | did | reason |
| --- | --- | --- | --- |
