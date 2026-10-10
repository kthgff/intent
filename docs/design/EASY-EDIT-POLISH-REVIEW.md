# Easy Edit usability and visual review

2026-10-07. Scope: table, editor, semantic inspector, sticky editor.

## Findings and plan

1. **Blocker · consistency/legibility · token:** white table inherits dark-theme foreground. Use paired chrome background/foreground tokens.
2. **Major · responsiveness · layout:** at 375px the app sidebar leaves a 225px work area; the drawer is not a viewport sheet. Use a fixed sheet and horizontally scrollable dense table; preserve application navigation outside this scope.
3. **Major · error recovery · component:** switching text fields cancels another field's pending change, closing drops drafts. Accumulate draft fields and flush on explicit close/blur; preserve active draft on save acknowledgement.
4. **Major · efficiency · component:** row keyboard navigation changes highlight without moving focus; nested button Enter is intercepted. Move actual focus and leave control keys alone.
5. **Major · error prevention · component:** tray checkboxes feed board-only bulk endpoint. Disable tray bulk selection, keep per-item editing/promotion, fail the whole operation on missing fences.
6. **Major · feedback · layout:** bulk toolbar inherits canvas translation. Reset transform and wrap controls.
7. **Major · efficiency · component:** sticky autosave acknowledgement resets selection/draft. Initialize only when entering edit mode; gate editor by locked/read-only state.
8. **Polish · hierarchy · layout/copy:** inspector is an undifferentiated form; group properties, lifecycle, evidence and provenance with clear section headings.
9. **Polish · discoverability · copy:** blank titles produce unnamed actions; show Untitled and distinguish Kind from Type.

## Directions

- **Refined ledger:** retain dense table, improve contrast, selected rows, grouped properties drawer and inspector. Responsive sheet preserves full editing.
- **Card inbox:** larger preview cards and detail sheet improve reading, but lose scanning density and violate D62's table shape.
- **Grouped workbench:** status-grouped table plus persistent detail pane improves triage, but adds grouping/persistence complexity and reduces available width.

Scores 1–5 (higher is better):

| Direction | Contract gate | Usability | Visual gain | Small blast radius | No spec drift |
| --- | --- | --- | --- | --- | --- |
| Refined ledger | Pass | 5 | 4 | 5 | 5 |
| Card inbox | Fail | 4 | 5 | 2 | 1 |
| Grouped workbench | Pass | 4 | 4 | 2 | 3 |

Choose **refined ledger**: fixes observed failures without adding a second interaction model. Desktop uses 32px rows, 360px drawer, themed chrome and restrained selection tint. Below 900px editor is a fixed viewport sheet; narrow tables scroll with Kind/Text/Status retained. Fields have visible labels, lifecycle actions a distinct footer, provenance a disclosure. Motion uses existing canvas durations and reduced-motion override. Empty filter results offer reset, empty boards explain New. Saving feedback must not claim success before acknowledgement.

D62 semantics are retained. Tray exclusion from bulk clarifies the existing board-membership constraint, not a new promotion path. See verification section for remaining limitations; a complete capture matrix is not claimed until recorded.
