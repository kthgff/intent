# Prompt — Easy Edit board view: UI/UX redesign + implementation

You are a senior product designer + frontend engineer performing a
**redesign of the Easy Edit board view** — the non-spatial table mode
of the idea board (D62, `?view=edit`). The current design is not good
enough: it reads as a bolted-on table, not a product surface. Audit
it, propose a concrete design plan, then implement it. **Plan-then-
build; do not pause for sign-off.** The design plan is a written
deliverable — make it specific enough to be reviewable, then execute
it in the same pass.

The visual bar is the product it lives inside: the board canvas
chrome (D59) and the app-wide design system (focus-visible, tone
badges, shared `Tabs`/`Modal`/`ConfirmDialog`/`Field`, label maps,
`--space-*`/`--canvas-*` tokens). A redesign here means **better than
the canvas, consistent with the app** — a coherent visual direction,
not a reskin and not a new design language.

## 0. Clarifying questions — ask first

You may ask up to **three questions** for context and clarification.
Ask them **one at a time** — pose one, wait for the answer, then
decide whether the next is still needed. Do not batch questions. Do
not ask anything answerable from the codebase or `docs/`. When
answered or the budget is spent, proceed without pausing again.

Good candidates (only if genuinely unresolved): is 32px row density
still locked or may the redesign set its own density; is the
table-paradigm itself open (dense list/cards) or is "sortable table +
drawer" the shape; may the redesign touch shared
`components.tsx`/global tokens if it needs a new primitive.

## 1. Context

Easy Edit (`packages/ui/src/board-canvas/EasyEdit.tsx`, ~950 lines +
`EditDrawer.tsx` + `table.ts`/`history.ts`) renders all
`board_items` as a sortable/filterable/searchable table with
checkbox multi-select, OCC-fenced bulk operations, a collapsible tray
section with one-click promote, and a right-side write-first edit
drawer. It mounts inside `screens/IdeaBoard.tsx` as the `Easy Edit`
topbar mode, gated by `ui.idea_canvas_v2`. Its styles are the
`/* ---- EASY-EDIT` section of `packages/ui/src/styles.css` (~line
2445 onward, `ee-*` classes riding `--canvas-*` tokens).

**Binding specs — read first; code must implement them:**

- `docs/TRACKER.md` **D62** — the feature contract (dense rows,
  drawer-not-inline editing, keyboard map j/k/Enter/e/x/`/`/Esc/`?`,
  bulk destructive = confirm ≥10 + undo toast, discarded rows muted,
  geometry never read or written, functional <900px, drawer→sheet at
  375px).
- `docs/prompts/implement-easy-edit.md` — acceptance criteria
  `case:easy-edit-01…09`. These are contracts: a prettier UI that
  breaks a case is a regression, not a redesign.
- `docs/design/BOARD-CANVAS-TDD.md`, D57/D59 — the canvas chrome and
  design-system idioms you're consistent with.
- `AGENTS.md` — repo conventions; spec changes get resolved +
  implemented + backported to `docs/`, never silently worked around.

## 2. Phase A — Audit

Before proposing anything, see the current state — do not design
blind.

1. **Capture the baseline.** `pnpm install && pnpm -r build`, then
   `node packages/cli/dist/bin.js daemon` (UI+API on `:4711`;
   bootstrap
   `http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)`).
   Open `/boards/<ws>/<board>?view=edit` on a populated board and
   screenshot every surface you'll redesign — table, toolbar, bulk
   bar, drawer, tray, empty states — at 1440px dark + light, plus
   880px and 375px. If you cannot run it, mark the audit
   "code-review only" and say so in the report.
2. **Read the implementation.** The component, the drawer,
   `table.ts`, and the whole `ee-*` CSS block. Inventory every state
   and interactive element.
3. **Report findings** as a compact numbered list ranked by
   severity, tagged `ux-flow` | `visual` | `state-coverage` | `a11y`
   | `copy` | `consistency` | `spec-drift` | `bug`. Judge against:
   visual hierarchy (is `+ New` unmistakable? do sort/filter/checked/
   locked/discarded states read at a glance?), scanability, state
   coverage, micro-interactions, copy, accessibility, cross-surface
   consistency, pixel detail (alignment, truncation, `tabular-nums`,
   sticky elements, hit areas).

## 3. Phase B — Design plan

Write the plan **before touching code**. It must be concrete —
tokens, values, and components, not adjectives. Include:

- **Design direction** — one-paragraph concept for what this surface
  should feel like (e.g., a precision data instrument vs. a friendly
  doc). Everything downstream must serve it.
- **Layout** — the structure of toolbar/table/tray/drawer at each
  breakpoint; what moves, what stays. Any structural change must name
  the D62 clause it amends (see constraints).
- **Visual system** — type scale, spacing rhythm on `--space-*`,
  which `--canvas-*`/app tokens each element consumes, badge/severity
  tone usage, borders vs. zebra vs. elevation for row separation,
  icon set (lucide only) and optical sizing.
- **States & motion** — hover/focus-visible/selected/checked/
  disabled/busy for every control; empty/error/OCC-conflict states;
  transitions on `--dur`/`--ease`; `prefers-reduced-motion`.
- **Spec deltas** — any proposal that changes a D62-locked decision
  (density, drawer-vs-inline, keyboard map) listed explicitly as a
  proposed amendment with rationale. Do not smuggle them into the
  diff.

Then implement the plan in the same pass.

## 4. Phase C — Implement

- Order: CSS/tokens first, then component structure, then copy/ARIA.
- **Ride the design system.** Reuse `--canvas-*`/`--space-*` tokens,
  `canvas-icon-button`, `canvas-multibar`, the inspector-aside
  pattern, and shared app components (`StatusBadge`, `Modal`,
  `ConfirmDialog`, `Tabs`, `Field`, `Empty`, `Loading`, `ErrorBox`,
  label maps). Extend `ee-*` where no shared pattern exists; add a
  shared primitive only if the plan justifies it and `components.tsx`
  is the right home.
- **Both themes, all widths.** Dark + light; 1440px, 880px, 375px.
- **Visual QA loop — mandatory.** After implementing, screenshot the
  same surface set you captured in Phase A at the same viewports/
  themes. Review them like a design critic: squint test for
  hierarchy, alignment grid, state legibility, theme contrast. Fix
  what reads wrong and re-capture. Iterate until it reads right —
  "pixel perfect" is proven by captures, not asserted.

## 5. Hard constraints

- **Behavior contracts are untouchable** unless a Phase B amendment
  was logged: OCC fencing (`expected_updated_at`), one-PATCH-per-
  field autosave, bulk = exactly one batch request, ≥10-row discard
  confirm + undo toast, locked rows read-only, no geometry keys in
  any payload, tray promote stays positionless, `?view=edit`
  deep-linking, `case:easy-edit-01…09` semantics.
- **Spec amendments are decisions, not diffs.** Anything that
  changes D62 gets an appended note under D62 (or a new decision) in
  `docs/TRACKER.md` in the same change.
- **Canvas regression check required** — `ee-*` shares classes with
  the canvas. After CSS changes, eyeball the `Idea` canvas mode too.
- **No new dependencies.** lucide-react and everything else needed
  is already there.
- **Contain your diff** to `board-canvas/EasyEdit.tsx`,
  `EditDrawer.tsx`, `table.ts`, the `ee-*` section of `styles.css`,
  shared `components.tsx`/tokens (only if the plan justified a new
  primitive), and `test/easy-edit*.test.*`. The worktree is dirty
  with unrelated work — don't run formatters over the repo. Do not
  touch `BoardCanvas.tsx`, `nodes.tsx`, `overlays.tsx`,
  `Inspector.tsx`, or the canvas CSS section except to *consume*
  shared classes.
- **`pnpm typecheck`, `pnpm test` (`easy-edit*` specs especially),
  `pnpm lint` stay green.** Tests asserting old copy/classes get
  updated in the same diff — never deleted to pass.
- **Secrets never enter code, config, or logs.**
- **Don't commit** — leave changes uncommitted for review.

## 6. Verification

1. **Computed-style reasoning** — trace values for every visual
   change; catch overflow/collision by geometry, not vibes.
2. **Live pass** — the daemon/screenshot routine from Phase A,
   post-redesign: toolbar, sorted columns, filtered/search states,
   multi-select + bulk bar, drawer open/edit/autosave, tray collapse
   + promote, empty + locked + discarded rows — 1440px dark + light,
   880px, 375px — plus one `Idea`-mode check for canvas regression.
   Before/after captures go in the report.
3. **Keyboard walk** — j/k, Enter/e, x, /, Esc, ? — focus visible at
   every step, `?` hint accurate after your changes.
4. **Green gates** — `pnpm typecheck && pnpm test && pnpm lint`.

## 7. Deliverable

1. **Audit findings** — ranked, tagged (Phase A).
2. **Design plan** — the Phase B document, including spec deltas.
3. **The implementation diff** — contained per §5.
4. **Verification output** — gates + before/after live-capture
   summary (viewports, themes, canvas spot-check).
5. **`docs/TRACKER.md`** — D62 amendment or new decision entry for
   every spec-level change; routine visual changes need no entry.
