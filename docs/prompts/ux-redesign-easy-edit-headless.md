# Prompt — Easy Edit board view: UI/UX redesign + implementation (headless)

You are a senior product designer + frontend engineer performing a
**redesign of the Easy Edit board view** — the non-spatial table mode
of the idea board (D62, `?view=edit`). The current design is not good
enough: it reads as a bolted-on table, not a product surface. Audit
it, propose a concrete design plan, then implement it. **Plan-then-
build in one pass.**

The visual bar is the product it lives inside: the board canvas
chrome (D59) and the app-wide design system (focus-visible, tone
badges, shared `Tabs`/`Modal`/`ConfirmDialog`/`Field`, label maps,
`--space-*`/`--canvas-*` tokens). A redesign here means **better than
the canvas, consistent with the app** — a coherent visual direction,
not a reskin and not a new design language.

**This is a non-interactive run.** You cannot ask questions and
cannot use a browser. Resolve ambiguity from the codebase and `docs/`;
record every assumption you made in the final report. Visual
verification is **code-review only** — substitute computed-style
reasoning for screenshots (trace every changed value; catch
overflow/collision by geometry, not vibes).

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

## 2. Phase A — Audit (code-review only)

Read the component, the drawer, `table.ts`, and the whole `ee-*`
CSS block. Inventory every state and interactive element. Report
findings as a compact numbered list ranked by severity, tagged
`ux-flow` | `visual` | `state-coverage` | `a11y` | `copy` |
`consistency` | `spec-drift` | `bug`. Judge against: visual
hierarchy (is `+ New` unmistakable? do sort/filter/checked/locked/
discarded states read at a glance?), scanability, state coverage,
micro-interactions, copy, accessibility, cross-surface consistency,
pixel detail (alignment, truncation, `tabular-nums`, sticky
elements, hit areas).

## 3. Phase B — Design plan

Write the plan **before touching code**. It must be concrete —
tokens, values, and components, not adjectives. Include:

- **Design direction** — one-paragraph concept for what this surface
  should feel like. Everything downstream must serve it.
- **Layout** — toolbar/table/tray/drawer structure at each
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
- **Assumptions** — every ambiguity you resolved without asking.

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
- **Both themes, all widths** — reason through dark + light and
  1440px/880px/375px in computed styles.
- **Self-review loop** — after implementing, re-read the rendered
  output (component markup + computed styles) like a design critic:
  squint test for hierarchy, alignment grid, state legibility, theme
  contrast. Fix what reads wrong.

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
  the canvas (`canvas-icon-button`, `canvas-multibar`, `badge`,
  `button.small`, `modal` idioms). Reason through the impact of every
  shared-class change on `Idea` canvas mode.
- **No new dependencies.** lucide-react and everything else needed
  is already there.
- **Contain your diff** to `board-canvas/EasyEdit.tsx`,
  `EditDrawer.tsx`, `table.ts`, the `ee-*` section of `styles.css`,
  shared `components.tsx`/tokens (only if the plan justified a new
  primitive), and `test/easy-edit*.test.*`. Do not touch
  `BoardCanvas.tsx`, `nodes.tsx`, `overlays.tsx`, `Inspector.tsx`,
  or the canvas CSS section except to *consume* shared classes.
- **`pnpm typecheck`, `pnpm test` (`easy-edit*` specs especially),
  `pnpm lint` stay green.** Tests asserting old copy/classes get
  updated in the same diff — never deleted to pass.
- **Secrets never enter code, config, or logs.**

## 6. Verification

1. **Computed-style reasoning** — trace values for every visual
   change; catch overflow/collision by geometry, not vibes.
2. **Keyboard walk** — trace j/k, Enter/e, x, /, Esc, ? through the
   component code — focus visible at every step, `?` hint accurate
   after your changes.
3. **Green gates** — run `pnpm typecheck && pnpm test && pnpm lint`
   from the repo root and fix what fails.

## 7. Deliverable

End the run with a report containing:

1. **Audit findings** — ranked, tagged (Phase A).
2. **Design plan** — the Phase B document, including spec deltas and
   assumptions.
3. **What changed** — file-by-file summary of the diff.
4. **Verification output** — gates results; state explicitly that the
   pass was **code-review only** (no browser verification) so a human
   knows to eyeball it.
5. **`docs/TRACKER.md`** — D62 amendment or new decision entry for
   every spec-level change; routine visual changes need no entry.
