# Easy Edit item page + landing redesign plan

Status: accepted for implementation 2026-10-08 (D68). This plan refines
`EASY-EDIT-PRD.md` without changing the board-item data model.

## Product choices

- URL: `?view=edit&item=<id>`. The query sub-view keeps `IdeaBoard` as the
  route/data coordinator while making an editor reloadable and shareable.
- Navigation: one clear Back/Escape path to the persisted list; no previous/
  next controls in this pass.
- Capture: a compact, single-line affordance expands in place into the shared
  `CaptureForm`. The complete capture contract remains available.

## Layout

```text
Easy Edit list
┌ Capture an idea · short guidance                         [Expand] ┐
├ Items · result count   [search] [filters]       [+ New] [?]      ┤
├ bulk actions (only while rows are selected)                      ┤
├ dense sortable board rows                                        │
└ collapsible capture-tray rows                                    ┘

Item page — ?view=edit&item=<id>
┌ ← Back to Easy Edit       board / item context       save state ┐
├ editable title headline                                         ┤
├ description / link URL             properties rail              │
│                                     status · type · importance   │
│                                     note status · color          │
│                                     tray/board · discard         │
│                                     provenance/details           │
└──────────────────────────────────────────────────────────────────┘
```

## Components and data flow

- `IdeaBoard` reads/writes the `item` search parameter and retains the existing
  OCC-fenced `patchItem`, `mutate`, `promote`, and refresh paths.
- `EasyEdit` projects the table, persists search/sort/filter state, owns row
  focus, and swaps the list for `ItemEditorPage` when `item` is present.
- `ItemEditorPage` absorbs the deleted drawer's draft, debounce, lock,
  properties, action, and provenance behavior. All prose fields reuse
  `DictationField`.
- Opening pushes a history entry. Browser Back clears it naturally; the page's
  Back control and Escape remove `item` and restore focus to the originating
  row. An unknown id reports a notice and fails closed to the list.

## Styling and documentation

- Replace scrim/drawer CSS with a responsive two-column page that becomes one
  column below 900 px and remains usable at 375 px.
- Treat Easy Edit as a themed application workspace rather than a white canvas:
  use the shared light/dark background, surface, border, text, and accent tokens;
  switch its canvas topbar to a full-width app bar; and preserve the floating
  white-paper chrome only in Idea mode.
- Reorder landing hierarchy so capture is compact, item tools are grouped, and
  empty/filter-empty states have distinct guidance.
- Rewrite PRD R2/R6/R7, TDD/architecture drawer mechanics, S-16 inventory text,
  and record D68 in `TRACKER.md`.
