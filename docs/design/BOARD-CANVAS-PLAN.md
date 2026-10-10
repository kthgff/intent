# Veto board-canvas delivery plan

Status: proposed 2026-10-06. Companion to
[`BOARD-CANVAS-TDD.md`](BOARD-CANVAS-TDD.md).

## Product decisions

The October 6 design interview selected:

- core spatial-canvas parity rather than a visual-only reskin or full Miro
  collaboration suite;
- theme-aware light and dark canvases;
- typed stickies, free text, zones, connectors, links, and images in release 1;
- type-derived colors that users may override;
- freeform placement, with grouping available only as an explicit undoable
  arrange command;
- a contextual floating toolbar plus a semantic right inspector;
- asynchronous collaboration through autosave, SSE refresh, and OCC conflicts;
- desktop editing with a simplified small-screen read surface;
- deterministic, non-writing layout for legacy unpositioned items; and
- a Veto-branded interpretation of Miro interaction patterns.

The product name is **Veto**. UI copy, docs, test fixtures, screenshots, and
accessibility labels must use that spelling consistently.

## Workstream sequence

### WP-A — Contracts and persistence

Scope: enums/schemas, binding docs, migration, Store interfaces, batch OCC,
connectors, and image metadata/storage boundary.

Exit criteria:

- legacy rows read without migration-time coordinate writes;
- strict schemas reject unknown kinds/colors and invalid geometry;
- multi-item writes are atomic under stale fences;
- connectors never reuse `serves`;
- migration and store contract suites are green.

### WP-B — Board API

Scope: expanded board projection, atomic mutation route, connector CRUD, safe
image upload/read, SSE invalidation, and typed UI client.

Exit criteria:

- every mutation is workspace/board qualified and authenticated;
- consumed/frozen items remain immutable;
- a stale member prevents an entire batch;
- invalid uploads leave no row or orphaned file;
- Fastify injection tests cover success and failure paths.

### WP-C — Canvas foundation

Scope: React Flow dependency, projection adapter, deterministic legacy layout,
viewport persistence, custom nodes/edge, selection, pan/zoom, drag/resize, and
zone membership.

Exit criteria:

- opening a legacy board performs no writes;
- pointer and keyboard movement persist the same geometry contract;
- refresh preserves viewport and valid selection;
- consumed/frozen objects render locked;
- the 300-node performance fixture meets the TDD budget.

### WP-D — Editing and Veto semantics

Scope: creation rail, sticky/text/link/image creation, hybrid color behavior,
selection toolbar, semantic inspector, statement actions, tray promotion,
undo/redo, arrange commands, autosave, and conflict recovery.

Exit criteria:

- common formatting never requires the inspector;
- taxonomy/provenance/lifecycle remain visible and authoritative;
- every successful action can be undone until a remote edit invalidates its
  fence;
- conflict drafts are recoverable and never silently merged;
- tray promotion can place an item at the drop point in one guarded operation.

### WP-E — Visual, accessibility, and rollout hardening

Scope: Veto-branded light/dark polish, responsive read mode, object-list
alternative, focus management, reduced motion, Playwright workflows, visual
baselines, feature flag, telemetry, and removal of the lane renderer after
dogfood acceptance.

Exit criteria:

- complete keyboard path for create/select/edit/move/connect/delete;
- type/status/provenance/save state do not rely on color;
- deterministic screenshots pass for both themes;
- small screens cannot enter a broken edit state;
- full repository install/typecheck/test/lint suite is green.

## Test-first slices

Each work package starts with the narrowest failing contract or interaction
test, then implements that behavior. Recommended vertical slices are:

1. unpositioned notes project deterministically and opening causes no PATCH;
2. create a typed sticky at the clicked canvas coordinate;
3. drag one note and persist one OCC-fenced mutation;
4. drag a selection and prove all-or-nothing conflict behavior;
5. resize and move a zone with active children;
6. connect two active notes without changing `serves`;
7. change note type, accept its default color, then override the color;
8. edit text with debounced save and recover from a remote conflict;
9. undo and redo a server-acknowledged move;
10. upload, render, and reject unsafe/oversized image bytes;
11. receive an SSE invalidation and reconcile without losing viewport;
12. complete the board workflow using only the keyboard and object list.

## Rollout

1. Ship disabled behind `ui.idea_canvas_v2` with fixture boards.
2. Enable for internal dogfood on new boards; keep legacy lane view available.
3. Enable legacy projection for existing boards and measure conflicts, asset
   failures, render time, and client exceptions for at least one release cycle.
4. Make the canvas default after visual/accessibility acceptance.
5. Remove the lane renderer and flag only after rollback is no longer needed.

Rollback disables the flag and returns to the lane renderer. New fields and
tables remain additive; image files remain referenced and recoverable. There is
no eager coordinate migration to reverse.

## Definition of done

- The canvas meets every in-scope outcome and non-happy path in the TDD.
- Binding docs and schemas match the shipped API/database behavior.
- Existing board, tray, statement, and Delivery-mode tests remain green.
- Visual approval covers empty, populated, selected, editing, saving, conflict,
  consumed, upload-error, light, dark, and small-screen read states.
- `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm lint` all pass.
