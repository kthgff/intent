---
schema: 1
id: wp-166
title: Proposal ghost projection — pending proposals as ghost nodes/edges on the v2 canvas
status: done
priority: medium
depth: standard
repos: []
wave: W24
depends_on: [wp-161]
---

## Description
BOARD-CHAT-PRD R3 rendering + TDD "UI"/placement projection.
`projectProposals(proposals, items)` — pure function projecting
`status='pending'` `board_proposals` rows to ghost `CanvasNode`s /
`CanvasEdge`s flagged `data.ghost` (create→ghost card at stored x/y;
patch→ghost diff styling on the target; move→ghost at target position;
serve/connect→ghost edge; delete→ghost `discarded` treatment). Ghosts:
dashed outline + `proposed` chip + assistant attribution; NOT
draggable, NOT selectable, excluded from history, marquee, and
undo; vanish on resolve (they're a projection — the rows are truth).
`BoardCanvas.tsx` gains an optional `ghosts`/`projected` prop + render
path — dormant until wp-165's IdeaBoard wiring (this ticket must not
touch IdeaBoard.tsx — owned by wp-165). Click on a ghost surfaces the
source proposal (callback prop; wp-165 wires it to thread scroll).
O(pending) memoized on `(proposals, items)` per TDD perf budget.
`styles.css` ghost chrome — NOTE: styles.css is wp-165's file; put the
`2px dashed` + proposed-badge rules in THIS ticket's own block only if
the ownership split lands cleanly, else hand the CSS spec to wp-165 in
the PR description (flag it in the ticket per parallel-agent rule 3).

## File ownership
`packages/ui/src/board-canvas/model.ts`,
`packages/ui/src/board-canvas/nodes.tsx` (or ghost render path wherever
card rendering lives), `packages/ui/src/board-canvas/BoardCanvas.tsx`,
`packages/ui/src/board-canvas/assistant.ts` (`projectProposals` —
coordinate with wp-165: this file is created here or there, one owner),
`packages/ui/test/*` per convention

## Acceptance criteria
- [ ] Pending proposals render as ghosts for every op kind (per-op fixtures)
- [ ] Ghosts excluded from selection/marquee/history/undo
- [ ] Ghost prop absent → zero visual change (dormant path)
- [ ] Resolve a proposal → ghost disappears on next projection (no stale ghosts)
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None — pure projection over wp-161 schemas.
