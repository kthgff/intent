# Prompt — Veto board-canvas review + visual polish

You are taking over a nearly-complete feature: a Miro-inspired spatial
idea-board canvas for Veto. The implementation is done and green —
your job is to **review it, then clean up the styles to a
pixel-perfect, pristine finish**. This is a polish pass, not a
rewrite.

## 1. Context

Veto is a governance layer for agent-authored code. The idea board is
its capture/discovery surface. We just replaced the lane-based board
with an infinite spatial canvas (React Flow 12): sticky notes, free
text, zones/frames, connectors, links, a floating tool rail, a
right-side semantic inspector, and a bottom capture tray.

**Binding specs — read these first. Code must implement them, not
reinterpret them.**

- `docs/design/BOARD-CANVAS-TDD.md` — technical design (state model,
  interaction model, a11y/perf budgets)
- `docs/design/BOARD-CANVAS-PLAN.md` — work packages + rollout
- `docs/prompts/implement-miro-inspired-board.md` — locked product
  decisions + acceptance criteria (`case:canvas-*`)
- `docs/TRACKER.md` decision log — D57 (canvas decisions), D58
  (migrations are immutable once applied — **never edit an applied
  migration file, comments included**)

## 2. Scope — what you're doing

### Phase A: Review

Review the implementation against the specs and report findings before
changing anything. Cover:

- **Correctness**: does behavior match the TDD + acceptance criteria?
  Flag anything that drifts (write paths, OCC/conflict flow, zone
  membership, read-mode gating, legacy-item projection).
- **Visual quality**: spacing, alignment, border radii, shadows,
  color/tone consistency, zoom-dependent legibility, overlap/clipping
  of floating chrome, empty + overflowing states.
- **States**: hover, selected, focused, disabled, locked
  (consumed/frozen), dragging, connecting, editing — each should look
  deliberate on the white dotted surface.
- **Both themes**: canvas surface is always white + dotted; floating
  chrome follows the app theme (dark panels in dark mode). Check
  contrast in both.
- **A11y/regression check**: keyboard flows, focus rings, ARIA labels,
  the objects list, reduced-motion — confirm they still work after
  your changes.

Report findings as a numbered list ranked by severity (visual-polish
vs spec-drift vs bug), each with `file:line` evidence and the intended
fix. Then **proceed straight into Phase B in the same pass** — do not
pause for sign-off.

### Phase B: Style cleanup

Fix the findings. The goal is **pristine**: consistent spacing
rhythm, aligned edges, intentional shadows/borders, no dead styles,
no duplicated rules, tidy token usage.

Verify visuals by reading the computed markup/styles and reasoning
about layout — there is no browser screenshot harness in this repo,
so precision comes from knowing exactly what every declaration does at
100%/zoomed-out/read-mode widths. The human will do the visual pass
after; leave it worthy.

Specific places to scrutinize:

- `packages/ui/src/styles.css` — the `BOARD-CANVAS` section (~line
  985 to end). Consolidate repeated declarations, tighten token usage,
  remove anything unreferenced.
- Node renderers in `packages/ui/src/board-canvas/nodes.tsx` —
  padding, text clamping, badge alignment, editor inset styling.
- Floating chrome in `packages/ui/src/board-canvas/overlays.tsx` and
  `Inspector.tsx` — toolbar spacing, icon alignment, panel
  width/scroll behavior.
- `packages/ui/src/board-canvas/ConnectorEdge.tsx` — label chip
  positioning and stroke weight at different zoom levels.

## 3. Hard constraints

- **No major refactors.** Do not restructure components, change the
  state model, alter the durable↔projection architecture, or touch
  API routes. CSS and minor markup/class changes only. If a finding
  *requires* a structural fix, report it separately — don't do it.
- **Contain your diff.** The worktree carries unrelated local changes
  — only touch `packages/ui/src/board-canvas/`,
  `packages/ui/src/screens/IdeaBoard.tsx`, the BOARD-CANVAS section of
  `packages/ui/src/styles.css`, and `docs/`. Never run
  `biome --write`/`lint:fix` over the whole repo — lint only files
  you changed.
- **No new dependencies.**
- **Leave changes uncommitted** — the user reviews the diff before any
  commit.
- **Specs are binding.** If style cleanup would change specified
  behavior (e.g., read-mode affordances, locked-item presentation),
  keep the behavior. Resolve real spec gaps by implementing AND
  backporting to the relevant `docs/*.md` in the same change.
- **No Miro branding.** Miro-inspired, never Miro-named — no Miro
  logo, colors-as-brand, or product copy. The surface is Veto's.
- **Fail-closed.** Malformed structured input stays a hard error.
- **Secrets** never enter code, config, or logs.
- **`pnpm typecheck`, `pnpm test`, `pnpm lint` must all stay green.**
- Import workspace deps as `@veto/<pkg>`; real `git`, never
  isomorphic-git; ESM + strict TS + `exactOptionalPropertyTypes`.

## 4. File map

| Path | What |
| --- | --- |
| `packages/ui/src/board-canvas/BoardCanvas.tsx` | orchestrator — React Flow wiring, gesture ends, OCC |
| `packages/ui/src/board-canvas/model.ts` | durable → node/edge projection |
| `packages/ui/src/board-canvas/nodes.tsx` | note/text/zone/link/image renderers |
| `packages/ui/src/board-canvas/ConnectorEdge.tsx` | connector edge + label chip |
| `packages/ui/src/board-canvas/overlays.tsx` | tool rail, zoom, objects panel, conflict/tray |
| `packages/ui/src/board-canvas/Inspector.tsx` | right-side semantic inspector |
| `packages/ui/src/board-canvas/layout.ts`, `history.ts` | legacy layout, undo/redo |
| `packages/ui/src/screens/IdeaBoard.tsx` | route coordinator, flag gate, classic fallback |
| `packages/ui/src/styles.css` | canvas visual system (tokens at ~line 989) |

## 5. Running it locally

```bash
pnpm install && pnpm -r build
node packages/cli/dist/bin.js daemon   # serves UI+API on :4711
```

- Token bootstrap: `open "http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)"`
- Flag is on: `ui.idea_canvas_v2: true` in `~/.config/veto/config.yaml`
- Test board: `/boards/intent/xfdsx` ("dfsfd") — or create a board
  from the Boards screen
- The daemon serves `packages/ui/dist` statically — after
  `pnpm -F @veto/ui build`, refresh the tab. If a daemon is already
  running and holding the port, its API code is in-memory: SIGTERM it
  (an open SSE tab can stall shutdown — SIGKILL is safe) and restart.

## 6. Deliverable

1. Findings list (numbered, severity-ranked) — share before fixing.
2. The style cleanup diff.
3. `pnpm typecheck && pnpm test && pnpm lint` output.
4. Update your row in `docs/TRACKER.md`; log any new decisions per
   the decision-log convention.
