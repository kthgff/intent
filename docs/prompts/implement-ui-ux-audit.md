# Prompt — Implement the Veto app-wide UI/UX audit fixes

You are a senior frontend engineer + product designer implementing the
findings of `docs/UI-UX-AUDIT.md` — a completed research-only audit of
every Veto screen EXCEPT the idea board. Your job: **review the
analysis, verify it against the code, then fix it** — as a top UI/UX
expert would. Report-then-fix in the same pass; do not pause for
sign-off.

## 0. Clarifying questions — ask first

You may ask up to **three questions** for context and clarification.
Ask them **one at a time** — pose one, wait for the answer, then decide
whether the next is still needed. Do not batch questions. Do not ask
anything answerable from the codebase, `docs/`, or the audit itself.
When answered or the budget is spent, proceed without pausing again.

Good candidates (only if genuinely unresolved): quick-wins-only vs.
structural fixes too; whether to update `docs/UI-UX-AUDIT.md` with a
status table vs. leave it untouched; commit/branch strategy (default:
uncommitted, one logical change).

## 1. Context

Veto is a governance layer for agent-authored code. UI stack: React 18
+ react-router-dom v6 + Vite; hand-rolled CSS in
`packages/ui/src/styles.css` (~2.4k lines; the `/* ---- BOARD-CANVAS`
section onward is the out-of-scope canvas system); lucide-react icons;
Inter + JetBrains Mono bundled via `@fontsource` in `main.tsx`.
The daemon serves UI+API on `:4711`.

**Binding references — read first:**

- `docs/UI-UX-AUDIT.md` — **the source of truth**: 175 findings with
  IDs (G1–G25 global; per-screen lettered IDs), tags, severities, and
  concrete recommendations. Work through it systematically — every ID
  gets a verdict and a fix-or-defer decision.
- `docs/UI-INVENTORY.md`, `docs/PRD.md` §15 — specified behavior;
  authoritative.
- `docs/TRACKER.md` decision log — D26 (vocabulary), D28 (inventory),
  D57/D59 (canvas — settled, out of scope).
- `AGENTS.md` — repo conventions. Spec gaps get resolved + implemented
  + backported into `docs/*.md` in the same change — never silently
  worked around.

## 2. Phase A — Validate the audit

The audit was produced by code review + live captures, but the
worktree is dirty (unrelated board-canvas/easy-edit work) and findings
may be stale or wrong. **Re-verify before you change anything.**

1. For each finding ID: confirm the claim against current source/CSS.
   Mark each `confirmed` | `stale` | `rejected` with a one-line reason
   (stale = code changed since audit; rejected = claim was wrong or a
   deliberate design choice).
2. Surface any finding whose recommended fix conflicts with a binding
   spec — resolve per `AGENTS.md` (resolve + implement + backport), or
   defer if it needs API/backend work.
3. Report the triage list (ID → verdict) before fixing. Keep it
   compact — a table, not prose.

## 3. Phase B — Fix

Implement in this order — globals first because they fix the most
visible damage per line:

1. **Design-system pass** — fonts (G1), `.status-*` tone maps + label
   humanization (G2/G12), dead class definitions (G15 — `.list`,
   `.panel`, `.link`, `.dim`, `.findings/.finding`, `.sev-*`,
   `.citation`, `.chat-*`, `.spec-dim`, etc.), spacing/radius tokens
   (G3 — introduce the scale and migrate the hot literals; do not
   mechanically rewrite all 2.4k lines), `tabular-nums` (G10),
   transitions + reduced-motion guard (G5), toast z-index (G6),
   `:focus-visible` (G4), narrow-width breakpoints (G20).
2. **Shared components** — `Modal`/`ConfirmDialog` (G7 + every
   destructive-confirm finding: T1, D3, R4, P1, RC1, W2, E1, M2),
   `Tabs` with full ARIA + arrow keys (G13), `Field` label
   association (G9), `ErrorBox` upgrade (G21), `Loading` spinner
   (G11), `DiffView` header fix (G14), `Empty` action slot.
3. **Per-screen wiring** — work the lettered findings screen by
   screen. Every fix must match its audit ID so the status table is
   traceable.
4. **Chrome** — theme select in Settings + `matchMedia` listener (G19),
   connection/live-state indicator + `?` shortcut help if feasible
   without API work (G18 partial); skip anything needing endpoints.

**Preservation rules:** current density stays (recommendations
tighten, never loosen); dark and light themes get equal attention —
every color change uses tokens, verified in both; desktop + narrow
viewports both checked; shared classes (`.card`, `.tabs`, `button`,
`.badge`) are also used by the out-of-scope canvas — changing them is
allowed but must not visibly regress it (spot-check one canvas screen
after the design-system pass).

## 4. Hard constraints

- **The idea board stays out of scope.** Do not edit
  `packages/ui/src/board-canvas/` or `screens/IdeaBoard.tsx`; do not
  restructure the BOARD-CANVAS section of `styles.css`. Shared-class
  changes are fine — regression-check the canvas visually once.
- **No new dependencies.** lucide-react, fonts, everything needed is
  already depended on. No `npm add`/`pnpm add`.
- **Deferred items stay deferred** — anything needing an API change,
  new store field, or new endpoint (audit §5 list) gets a status entry,
  not a stub.
- **No redesign.** Fix what's specified/audited; no new routes,
  layouts, or interaction models.
- **Contain your diff** to `packages/ui/src/`, `packages/ui/index.html`,
  `packages/ui/test/` (only if a fix needs coverage), `docs/UI-UX-AUDIT.md`
  (status section), `docs/TRACKER.md` (decision log). The worktree has
  unrelated dirty files — do not run `biome --write` or formatters over
  the repo; touch only what your fixes need.
- **Specs are binding** — spec gaps: resolve + implement + backport
  into `docs/*.md`.
- **Secrets never enter code, config, or logs.**
- **`pnpm typecheck`, `pnpm test`, `pnpm lint` stay green.** Run them;
  report output.
- **Don't commit** — leave changes uncommitted for review.
- ESM + strict TS + `exactOptionalPropertyTypes`; workspace deps as
  `@veto/<pkg>`; real `git` only.

## 5. Verification

"Pixel-perfect" is proven, not asserted.

1. **Computed-style reasoning** — for every visual change, trace the
   computed values; catch overflow/collision by geometry.
2. **Live pass** — `pnpm install && pnpm -r build`, then
   `node packages/cli/dist/bin.js daemon` (UI+API on `:4711`; bootstrap
   `http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)`).
   Capture the same surfaces the audit captured: home, boards,
   capture, tray, new, workspaces, kb, metrics, ledger, settings,
   runs, queue, merge-center, releases, run-detail, inbox — at
   1440×900 dark + light, and 880×900 narrow. Compare against the
   audit's captured states; confirm no regression, confirm the fixes
   landed. If you cannot run it, mark the pass "code-review only" so a
   human knows to eyeball it.
3. **Green gates** — `pnpm typecheck && pnpm test && pnpm lint`.

## 6. Deliverable

1. **Triage table** — every audit ID → `confirmed` | `stale` |
   `rejected` + one-line reason.
2. **The fix diff** — contained per §4.
3. **Status section appended to `docs/UI-UX-AUDIT.md`** — ID →
   `fixed` | `deferred` | `rejected` + pointer to the change (file +
   selector) so the audit closes the loop.
4. **Verification output** — typecheck/test/lint results + the
   live-capture summary (which routes, viewports, themes).
5. **`docs/TRACKER.md` decision-log entry** — for any behavior or
   visual-system decisions (token scale, modal pattern, tab pattern,
   label maps, breakpoint choices); deferred items listed explicitly.
