# Prompt — Veto board-canvas full UI/UX polish (90 → 100)

You are taking over a shipped, green, visually-solid feature: a
Miro-inspired spatial idea-board canvas for Veto. A review+style
polish pass already landed (D59). Your job is the **last 10%**: a
full UI/UX review and cleanup pass — pixel-perfect detail, micro-
interactions, state coverage, copy, and affordances. **Polish, not
redesign.** The architecture, interaction model, and feature set are
locked; you're making the existing thing feel finished.

## 1. Context

Veto is a governance layer for agent-authored code. The idea board is
its capture/discovery surface — an infinite white-dotted canvas
(React Flow 12): sticky notes, free text, zones/frames, connectors,
links, a floating creation rail, right-side semantic inspector, and a
bottom capture tray.

**Binding specs — read these first. Code must implement them, not
reinterpret them.**

- `docs/design/BOARD-CANVAS-TDD.md` — state model, interaction model,
  a11y/perf budgets
- `docs/design/BOARD-CANVAS-PLAN.md` — work packages + rollout
- `docs/prompts/implement-miro-inspired-board.md` — locked product
  decisions + acceptance criteria (`case:canvas-*`)
- `docs/TRACKER.md` decision log — **D57** (canvas), **D58** (applied
  migrations are immutable — comments included; never touch one),
  **D59** (previous polish pass — read it so you don't re-litigate
  settled decisions or re-introduce removed code)

## 2. Phase A — Full UI/UX review

Report findings as a numbered list ranked by severity, tagged
`ux-flow` | `visual` | `state-coverage` | `a11y` | `spec-drift` |
`bug`. Then fix them in the same pass — do not pause for sign-off.

Review dimensions — go deep on each:

**Flows (walk them mentally + via code):**
- First-open of an empty board — is the empty state inviting and
  does it teach (hint, affordance, nothing blank)?
- Create → edit → autosave → connect → inspect → tray — each
  transition should feel deliberate: does the UI acknowledge what
  happened (save indicator, selection, focus)?
- Keyboard path through the same flows: shortcut hints visible where
  a user would look? Focus visible? Escape behaves?
- Conflict/OCC recovery — does the conflict UI explain itself in
  human language?
- Read mode (<900px): does it clearly *read* as read-only?

**States — every interactive element, every state:**
- hover / active / selected / focused-visible / disabled / locked
  (consumed/frozen) / dragging / connecting / editing / busy
- Empty, loading, error, and truncated states for every panel and
  node — including absurdly long text, zero items, huge boards
- Autosave indicator states (saving/saved/conflict/offline) —
  legible, honest, not flickery

**Micro-interactions & feel:**
- Transition timing + easing consistency — one duration scale, one
  easing curve; nothing instant-janky, nothing over-animated;
  `prefers-reduced-motion` honored everywhere (not just the spots
  already handled)
- Cursor inventory: every tool/surface shows the right cursor
- Hit areas ≥ comfortable size; icon optical sizing consistent
  (Lucide 19px rail icons, swatches, toolbar glyphs)
- Selection affordances: does a selected node *look* selected at
  every zoom? Connector label chips readable at 0.5×?

**Visual system:**
- Spacing rhythm — is there one scale (4/6/8/12/16) or scattered
  one-offs? Radius scale (4/6/8/10) consistent? Shadow elevation
  ladder intentional (rail < panels < modal/conflict)?
- Token hygiene: colors/dimensions ride `--canvas-*` / theme tokens;
  no stray literals, no dead rules, no duplicated declarations
- The white dotted surface vs floating chrome: borders/shadows
  strong enough in BOTH themes; chrome follows app theme, surface
  stays white
- Alignment: every floating element on the 10px edge grid; no two
  chrome elements collide at any viewport size; centered elements
  share one axis
- Typography: size steps consistent; truncation with ellipsis
  wherever text can overflow; `font-variant-numeric` where numbers
  tick

**Copy:**
- Every user-visible string: correct, concise, sentence-case,
  consistent verbs ("Clone"/"Add"/"Delete" patterns). Tooltips
  (`title`) on icon-only buttons. No jargon leakage, no dead copy,
  no Miro branding.

**A11y regression check:**
- ARIA labels/roles, keyboard tab order, focus restoration, the
  objects list as the non-spatial path — confirm all still work after
  your changes.

## 3. Phase B — Fix

Fix the findings. Allowed scope:

- CSS changes anywhere in the BOARD-CANVAS section of
  `packages/ui/src/styles.css`
- Minor markup/class/attribute changes in `packages/ui/src/board-canvas/*`
  and `packages/ui/src/screens/IdeaBoard.tsx` (class names, `title`
  attributes, aria attributes, element order, conditional classes)
- Copy edits to user-visible strings
- Small UX refinements that don't change the state model or data
  flow (e.g., a transition, a disabled-state hint, an autofocus,
  an Escape handler on a panel)

**Report separately, don't fix**: anything requiring a state-model
change, a new API field, a new dependency, or a component
restructure — list it under "deferred findings."

## 4. Hard constraints

- **No redesign.** If a finding wants a new component, new route,
  new store field, or a different layout model — defer it.
- **Specs are binding** — don't change specified behavior (read-mode
  affordances, locked-item presentation, OCC flow). If a spec gap
  surfaces, resolve + implement + backport the decision into the
  relevant `docs/*.md` in the same change.
- **No Miro branding** — Miro-inspired, never Miro-named.
- **No new dependencies.** No `npm add`, no new imports from
  packages not already depended on.
- **Contain your diff** to `packages/ui/src/board-canvas/`,
  `packages/ui/src/screens/IdeaBoard.tsx`, the BOARD-CANVAS section
  of `packages/ui/src/styles.css`, and `docs/`. Do not run
  `biome --write` or formatters over the repo — the worktree has
  unrelated dirty files; leave them alone.
- **Secrets never enter code, config, or logs.**
- **`pnpm typecheck`, `pnpm test`, `pnpm lint` stay green.**
- **Don't commit** — leave changes uncommitted for review.
- ESM + strict TS + `exactOptionalPropertyTypes`; workspace deps as
  `@veto/<pkg>`; real `git` only.

## 5. Visual verification

"Pixel-perfect" can't be proven by vitest. Do both:

1. **DOM/computed-style reasoning** — for every change, trace the
   computed values (sizes, positions, colors) and state the numbers;
   catch overflow/collision by geometry, not vibes.
2. **Live pass** — build (`pnpm -F @veto/ui build`), run the daemon,
   and if you have screenshot/DOM-capture capability, capture the
   board at: empty state, populated board, node selected, connector
   selected, inspector open, tray open, <900px read mode, dark +
   light theme. Otherwise state explicitly that visual verification
   was by code review only, so a human knows to eyeball it.

## 6. File map

| Path | What |
| --- | --- |
| `packages/ui/src/board-canvas/BoardCanvas.tsx` | orchestrator — RF wiring, gesture ends, OCC |
| `packages/ui/src/board-canvas/model.ts` | durable → node/edge projection |
| `packages/ui/src/board-canvas/nodes.tsx` | note/text/zone/link/image renderers |
| `packages/ui/src/board-canvas/ConnectorEdge.tsx` | connector edge + label chip |
| `packages/ui/src/board-canvas/overlays.tsx` | tool rail, zoom controls, objects panel, multiselect/connector bars, conflict, tray dock |
| `packages/ui/src/board-canvas/Inspector.tsx` | right-side semantic inspector |
| `packages/ui/src/board-canvas/layout.ts`, `history.ts` | legacy layout, undo/redo |
| `packages/ui/src/screens/IdeaBoard.tsx` | route coordinator, flag gate, classic fallback |
| `packages/ui/src/styles.css` | canvas visual system — `/* ---- BOARD-CANVAS` section onward + `--canvas-*` tokens |

## 7. Running it locally

```bash
pnpm install && pnpm -r build
node packages/cli/dist/bin.js daemon   # serves UI+API on :4711
```

- Token bootstrap:
  `open "http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)"`
- Flag is on: `ui.idea_canvas_v2: true` in `~/.config/veto/config.yaml`
- Test board: `/boards/intent/xfdsx` ("dfsfd") — or create a board
  from Boards; also a connected `Hello-World` repo exists for context
- The daemon serves `packages/ui/dist` statically — after
  `pnpm -F @veto/ui build`, refresh the tab. Restart pattern for API
  changes: SIGTERM the daemon (an open SSE tab can stall shutdown —
  SIGKILL is safe) and restart.
- Seed content fast: double-click empty canvas → sticky; draw a zone;
  connect two nodes; collapse/expand the tray; open the inspector on
  a locked vs editable item.

## 8. Deliverable

1. Findings list — numbered, severity-ranked, tagged by dimension;
   report then fix in the same pass.
2. The polish diff (contained per §4).
3. `pnpm typecheck && pnpm test && pnpm lint` output.
4. Updated `docs/TRACKER.md` decision-log entry for any behavior or
   visual-system decisions; deferred findings listed explicitly.
