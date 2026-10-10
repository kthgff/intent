# Prompt — Easy Edit board view: UI/UX expert polish pass

You are a senior product designer + frontend engineer performing a
**UI/UX review-and-fix pass on the Easy Edit board view** — the
non-spatial table mode of the idea board (D62, `?view=edit`). Review
it like a top design expert, then make it look and feel its best in
the same pass. **Report-then-fix; do not pause for sign-off.**

The visual bar is the surface it lives inside: the board canvas
chrome (D59 polished it) plus the app-wide design-system work that
just landed (focus-visible, tone badges, shared `Tabs`/`Modal`/
`ConfirmDialog`/`Field`, label maps, `--space-*`/`--canvas-*` tokens).
Easy Edit already *shares* some of that chrome (`canvas-icon-button`,
`canvas-multibar`, the inspector-aside idiom) — finish the job: it
should read as the same product, not a bolted-on table.

## 0. Clarifying questions — ask first

You may ask up to **three questions** for context and clarification.
Ask them **one at a time** — pose one, wait for the answer, then
decide whether the next is still needed. Do not batch questions. Do
not ask anything answerable from the codebase or `docs/`. When
answered or the budget is spent, proceed without pausing again.

Good candidates (only if genuinely unresolved): polish-only vs.
willingness to adjust layout structure (e.g., drawer vs. inline
editing stays drawer — locked); whether tray section styling should
match the canvas bottom-tray visually; tolerance for reordering
toolbar controls.

## 1. Context

Easy Edit (`packages/ui/src/board-canvas/EasyEdit.tsx`, ~950 lines +
`EditDrawer.tsx` + `table.ts`/`history.ts`) renders all
`board_items` as a dense, sortable/filterable/searchable table with
checkbox multi-select, OCC-fenced bulk operations, a collapsible
tray section with one-click promote, and a right-side write-first
edit drawer. It mounts inside `screens/IdeaBoard.tsx` as the
`Easy Edit` topbar mode, gated by `ui.idea_canvas_v2`. Its styles
are the `/* ---- EASY-EDIT` section of `packages/ui/src/styles.css`
(~line 2445 onward, `ee-*` classes riding `--canvas-*` tokens).

**Binding specs — read first; code must implement them:**

- `docs/TRACKER.md` **D62** — the locked feature decision (dense
  32px rows, drawer-not-inline editing, keyboard map
  j/k/Enter/e/x/`/`/Esc/`?`, bulk destructive = confirm ≥10 + undo
  toast, discarded rows shown muted, geometry never read or written,
  functional <900px with drawer→sheet).
- `docs/prompts/implement-easy-edit.md` — acceptance criteria
  `case:easy-edit-01…10`. These are contracts: a prettier UI that
  breaks a case is a regression, not a fix.
- `docs/design/BOARD-CANVAS-TDD.md`, D57/D59 — the canvas chrome
  you're matching (topbar, icon buttons, multibar, inspector aside,
  selection/focus rings, dark+light `--canvas-*` themes).
- `AGENTS.md` — repo conventions; spec gaps get resolved +
  implemented + backported, never silently worked around.

## 2. Phase A — Review

Read the component, the drawer, `table.ts`, and the whole `ee-*`
CSS block. Inventory every state and interactive element. Report
findings as a compact numbered list ranked by severity, tagged
`ux-flow` | `visual` | `state-coverage` | `a11y` | `copy` |
`consistency` | `spec-drift` | `bug`. Then fix them in the same
pass.

Review dimensions — go deep on each:

- **Visual system** — does it feel like the canvas product? Token
  hygiene (stray literals vs `--canvas-*`/app tokens), alignment of
  the toolbar/thead/cells on a consistent grid, kind/status/
  importance badges toned consistently with the app maps
  (`StatusBadge`, severity tones), table density rhythm (row
  padding, borders, zebra/hover treatment), icon optical sizing.
- **Hierarchy & scanability** — is the primary action (`+ New`)
  unmistakable? Do sort indicators, filter state, and the checked
  state read at a glance? Does a row's locked/discarded state read
  instantly without learning a legend?
- **Flows** — search → select → bulk op → undo toast; row → drawer →
  autosave → saved/conflict; tray → promote; `+ New` → focused row.
  Each transition should acknowledge what happened.
- **States** — hover/focus-visible/selected/checked/disabled/busy on
  every control; empty table, empty tray, empty search results,
  error/OCC-conflict, locked rows, discarded rows, long text
  truncation, huge boards (sticky header? scroll containment?),
  unsaved drawer close.
- **Micro-interactions** — transition durations/easing consistent
  with the canvas + app (`--dur`/`--ease`), `prefers-reduced-motion`
  respected, correct cursors, ≥30px hit areas where density allows.
- **Copy** — sentence case, humanized enums (no raw `note_kind`
  keys), tooltips/`aria-label` on icon-only controls, honest empty
  states that teach.
- **Accessibility** — real table semantics or correct ARIA grid,
  sortable-header `aria-sort`, checkbox label association, focus
  into/out of the drawer, roving focus preserved, the keyboard hint
  (`?`) accurate after your changes.
- **Cross-surface consistency** — toolbar vs. canvas topbar, bulk
  bar vs. `canvas-multibar`, drawer vs. canvas inspector, drawer vs.
  app `Modal` conventions (focus trap, Escape, restore), badges and
  buttons matching the app's `.badge`/`button` ladder.
- **Pixel-perfect detail** — column alignment, checkbox/radio hit
  areas, truncation + ellipsis, `tabular-nums` on the Updated
  column, sticky elements staying glued on scroll, no horizontal
  scrollbar until actually needed, drawer as sheet at 375px
  (`case:easy-edit-09`).

## 3. Phase B — Fix

- Fix every confirmed finding you can in markup/CSS. Order:
  CSS/tokens first, then component structure, then copy/ARIA.
- **Match the canvas, don't reinvent it.** Reuse `--canvas-*`
  tokens, `canvas-icon-button`, `canvas-multibar`, the
  inspector-aside pattern, and the shared app components
  (`components.tsx`: `StatusBadge`, `Modal`, `ConfirmDialog`,
  `Tabs`, `Field`, `Empty`, `Loading`, `ErrorBox`, label maps).
  Introduce `ee-*` rules only where no shared pattern exists.
- **Density is spec'd, not negotiable** (D62: dense 32px rows).
  Tighten and align; never loosen into a sparse layout.
- **Both themes, both widths.** Verify dark + light and
  desktop + narrow (the spec demands fully-functional <900px and a
  375px sheet drawer — check it, don't assume).
- **Behavior contracts are untouchable:** OCC fencing
  (`expected_updated_at`), one-PATCH-per-field autosave, bulk =
  exactly one batch request, ≥10-row discard confirm + undo toast,
  locked rows read-only, no geometry keys in any payload, tray
  promote stays positionless, the locked keyboard map, `?view=edit`
  deep-linking.

## 4. Hard constraints

- **Canvas regression check required** — Easy Edit shares classes
  with the canvas (`canvas-icon-button`, `canvas-multibar`,
  `badge`, `button.small`, `modal` idioms). After CSS changes,
  eyeball the `Idea` canvas mode too — a shared-class change that
  regresses the canvas is a failed pass.
- **No new dependencies.** lucide-react and everything else needed
  is already there.
- **No redesign.** No inline cell editing, no new interaction model,
  no restructure of the table→drawer flow — D62 locks these.
- **Contain your diff** to `board-canvas/EasyEdit.tsx`,
  `EditDrawer.tsx`, `table.ts`, the `ee-*` section of `styles.css`,
  and (only if a change needs it) `test/easy-edit*.test.*`. The
  worktree is dirty with unrelated work — don't run formatters over
  the repo; touch only what your fixes need. Do not touch
  `BoardCanvas.tsx`, `nodes.tsx`, `overlays.tsx`, `Inspector.tsx`,
  or the canvas CSS section except to *consume* shared classes.
- **`pnpm typecheck`, `pnpm test` (`easy-edit*` specs especially),
  `pnpm lint` stay green.** Tests that assert old copy/classes get
  updated in the same diff — never deleted to pass.
- **Secrets never enter code, config, or logs.**
- **Don't commit** — leave changes uncommitted for review.

## 5. Verification

"Best-looking" is proven, not asserted.

1. **Computed-style reasoning** — trace values for every visual
   change; catch overflow/collision by geometry, not vibes.
2. **Live pass** — `pnpm install && pnpm -r build`, then
   `node packages/cli/dist/bin.js daemon` (UI+API on `:4711`;
   bootstrap
   `http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)`).
   Open `/boards/<ws>/<board>?view=edit` (a populated board —
   `intent/xfdsx` if it still has items). Check: toolbar, sorted
   columns, filtered/search states, multi-select + bulk bar, drawer
   open/edit/autosave, tray collapse + promote, empty + locked +
   discarded rows — at 1440px dark + light, and 880px + 375px
   narrow. Then flip to `Idea` mode once to confirm the canvas is
   unregressed. If you cannot run it, mark the pass "code-review
   only" so a human knows to eyeball it.
3. **Keyboard walk** — j/k, Enter/e, x, /, Esc, ? — through the
   whole view, focus visible at every step.
4. **Green gates** — `pnpm typecheck && pnpm test && pnpm lint`.

## 6. Deliverable

1. **Findings list** — ranked, tagged, each → fixed or deferred
   (defer = needs an API/model change; list explicitly, don't drop).
2. **The fix diff** — contained per §4.
3. **Verification output** — gates results + the live-capture
   summary (view, viewports, themes, canvas spot-check result).
4. **`docs/TRACKER.md`** — append a note under D62 (or a new
   decision) only if the pass made a design decision worth logging
   (e.g., a new shared pattern); routine polish needs no entry.
