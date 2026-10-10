# Board canvas final UI/UX polish review

Date: 2026-10-07. Scope: the D57 spatial canvas after the D59 review.
This is a polish pass, not a change to the architecture, durable state,
or interaction model.

## Findings and resolutions

1. **P1 — `state-coverage`**: an empty board rendered as an unexplained
   dotted surface. **Fixed:** the first-open state now explains double-click
   creation, offers a primary “Add a sticky note” action, and shows the main
   keyboard shortcuts. Read mode gets separate empty-board guidance.
2. **P1 — `ux-flow`**: narrow-screen read mode removed editing mechanics but
   did not visibly identify itself as read-only; the disabled capture tray was
   still present. **Fixed:** a persistent read-only label names the available
   actions, mutation chrome and tray are hidden, primary drag pans, and Board
   objects plus the inspector remain available.
3. **P1 — `bug`**: tray promotion had no busy state and allowed an unhandled
   rejection on click or drop. **Fixed:** promotion is fenced by a local busy
   state, disables tray rows, and reports failure through the existing notice
   surface.
4. **P1 — `a11y`**: link creation returned before restoring focus to the new
   node, unlike frame creation; holding Space could also scroll the page while
   activating temporary pan. **Fixed:** both link and frame creation restore
   focus, Space suppresses page scrolling, and pending draft/keyboard timers
   are cleared on unmount.
5. **P2 — `state-coverage`**: “Saved” remained indefinitely and the failure
   badge said “retrying” although there is no automatic retry loop. **Fixed:**
   fast saves avoid a visual flash, Saved remains for 1.8 seconds, then settles
   to idle, and failures honestly read “Not saved.” Conflict state links to the
   recovery notice.
6. **P2 — `ux-flow`**: the OCC notice exposed an internal item identifier and
   implementation language instead of explaining the choice. **Fixed:** it now
   says that the latest version was restored, explicitly assures the user when
   their text is retained, and offers “Save my version” or “Keep latest.”
7. **P2 — `visual`**: canvas chrome mixed one-off radii, shadows, note colors,
   durations, and literal edge offsets. **Fixed:** the canvas section now owns
   a compact token set for its 6/8/10 px radius scale, two chrome elevations
   plus panel elevation, a 120/180 ms motion scale, one easing curve, note
   palette, selection color, and 10 px edge grid.
8. **P2 — `a11y`**: icon close controls used an unlabelled multiplication
   glyph, swatches did not expose their pressed state, and the correction field
   did not receive focus. **Fixed:** Lucide close icons have names/tooltips,
   swatches expose action + pressed state, correction editing moves focus
   programmatically, and Escape cancels correction editing.
9. **P2 — `visual`**: rail and zoom hit areas were undersized, while a 40 px
   rail would collide at short heights. **Fixed:** rail targets are 40×40 px,
   zoom targets 32×32 px, the rail is height-bounded and scrollable, and all
   controls share visible focus and active feedback.
10. **P2 — `visual`**: selection outlines and connector labels became too thin
    at low zoom. **Fixed:** one canvas-level zoom update writes inverse-scale
    CSS variables without re-rendering every edge. At 0.5×, selection outlines
    and handles remain approximately 2 px/10 px on screen, and connector label
    text remains approximately 11 px on screen.
11. **P2 — `state-coverage`**: long titles, hosts, image captions, tray rows,
    inspector content, and object rows had inconsistent overflow handling.
    **Fixed:** single-line identity fields truncate with ellipsis and retain
    title tooltips where needed; narrative content wraps anywhere inside its
    scroll container.
12. **P3 — `ux-flow`**: choosing an item from Board objects could leave that
    panel underneath the newly opened inspector. **Fixed:** locating an object
    selects and centers it, then closes the objects panel before the inspector
    appears.
13. **P3 — `copy`**: several controls used lowercase verbs, internal rollout
    terminology, or ambiguous labels. **Fixed:** action labels are sentence
    case, “Capture tray” and “Move to tray” name the destination, “Edit label”
    names the connector action, and disabled Synthesize/Image explanations no
    longer mention implementation tickets or server plugins.
14. **P3 — `visual`**: drag, panel-open, hover, active, disabled, saving, and
    connecting states did not share a consistent feel. **Fixed:** the canvas
    uses the shared motion tokens, restrained drag elevation, active scale,
    panel entrance, spinner, connecting-handle emphasis, and a complete
    `prefers-reduced-motion` override.

## Computed geometry verification

- Floating elements sit on the 10 px edge grid. The top bar reserves 90 px on
  both sides on desktop (`max-width: calc(100% - 180px)`), keeping the
  top-right save badge clear; below 900 px it becomes `width - 20 px` and hides
  workspace/Synthesize details.
- The left rail is 54 px wide including padding and borders and contains
  40 px square targets. Board objects begins at 74 px, leaving a 10 px gap
  beyond the rail's 64 px right edge.
- Zoom controls sit 44 px above the bottom edge, clearing the 34 px collapsed
  tray lip by 10 px and the React Flow attribution strip. In read mode, where
  the tray is absent, they return to the 10 px edge grid.
- Inspector and objects panels begin at 64 px. The inspector stops at 96 px
  to clear the zoom controls; the objects panel stops at 52 px. Their maximum
  widths leave the rail reachable; below 900 px the inspector becomes a
  10 px inset bottom sheet capped at 45% height.
- At 0.5× zoom the inverse scale is 2: a 4 px flow-space selection outline
  renders as 2 px on screen, a 20 px handle renders as 10 px, and an 11 px
  connector label counter-scales to remain approximately 11 px. Inverse scale
  is bounded from 0.5 to 4; label counter-scale is capped at 2 for density.
- Chrome uses 120 ms feedback and 180 ms entrances with
  `cubic-bezier(0.2, 0, 0, 1)`. Reduced-motion removes all canvas transitions
  and animations and viewport helpers already use zero-duration movement.

## Deferred findings

- The selection toolbar is anchored to its node and can approach or overlap
  fixed chrome near viewport edges. A collision-aware toolbar placement
  strategy needs additional layout ownership; this remains deferred.
- Save state currently represents the latest mutation rather than an aggregate
  of concurrent writes. Serializing autosaves, preserving every in-flight
  draft, and distinguishing all failure categories requires a persistence-state
  change beyond this polish brief. The failure copy no longer claims automatic
  retries or a successful restore before refresh finishes.

- A true modal focus trap for OCC recovery would require a dialog abstraction
  or component restructure. The current assertive notice is non-modal so the
  recoverable draft and both actions remain reachable without falsely claiming
  modal behavior.
- Restoring inspector focus to an exact selection neighbor after every remote
  deletion needs selection ownership to move from the route/canvas split into
  one focus manager. Existing node creation, panel correction, and ordinary
  close paths restore useful focus, but the remote-deletion edge case remains.
- Visual-regression baselines and automated high-contrast/axe coverage require
  test infrastructure outside this polish pass's permitted source/docs diff.

## Verification record

- Live Chrome checks observed the populated board, selected sticky/contextual
  toolbar, semantic inspector, and the 840×900 read-only view against the
  running local daemon. The white surface and dark floating chrome were
  visually inspected. That pass found the inspector/zoom overlap corrected
  by the 96 px bottom clearance.
- The final browser reload and reconnection timed out. Empty-board, selected
  connector, expanded tray, and light-theme screenshots were not completed;
  those states received source/CSS review only. No claim of a complete visual
  regression matrix is made.
- `pnpm typecheck` passed. UI tests passed (15 files, 87 tests). The UI
  production build passed with the existing large-chunk warning.
- `pnpm lint` failed with 31 diagnostics in the current wider worktree,
  including formatting/accessibility findings in other screens. The CSS
  diagnostics are before the BOARD-CANVAS section (font/transition formatting).
  They were left untouched under this brief's containment rule; no repository
  formatter was run.
