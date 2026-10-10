---
schema: 1
id: wp-165
title: Board Assistant panel — floating Thread/Understanding UI, skill pills, suggestion chips
status: done
priority: medium
depth: standard
repos: []
wave: W24
depends_on: [wp-161, wp-164]
---

## Description
BOARD-CHAT-PRD "Placement" + TDD "UI". `AssistantPanel.tsx` — floating,
draggable, collapsible panel over the canvas (copilot-style; position
persists to `localStorage veto.boardchat.pos.<ws>/<board>`; collapses
to a corner button). Tabs: **Thread** (message list — user/assistant/
system run markers; proposal-batch cards with per-item accept/reject +
accept-all) and **Understanding** (existing wp-146 payload, embedded —
never duplicated). `SkillPills` row (`/interview`, `/critique`,
`/expand` — inert with explanation when prerequisites missing) +
deterministic suggestion chips + `ChatInput` (`/` skills + freeform;
one clarifying-question flow surfaced as ordinary messages).
`model: 'absent'` → degradation banner visible (PRD R10). Mount in
`IdeaBoard.tsx` gated on `ui.idea_canvas_v2 && ui.board_chat`; loads
panel state via `api.ts` `assistant()`; `useStreamRefresh(load,
['interview_updated', 'board_proposal', 'board_item_updated'])`.
**IdeaBoard.tsx is exclusively owned here** — including the one-line
ghost-prop handoff to BoardCanvas (wp-166 ships the render path
dormant). Below 900 px: canvas is read-only, panel fully functional,
proposals render as an in-thread list (no canvas dependency to decide).
Message clicks deep-link to canvas position (pan/zoom). `styles.css`
gets a `/* ---- BOARD-CHAT */` block on existing semantic tokens.

## File ownership
`packages/ui/src/board-canvas/AssistantPanel.tsx` (new),
`packages/ui/src/board-canvas/assistant.ts` (new — chips display +
pure panel helpers), `packages/ui/src/IdeaBoard.tsx` (sole owner this
wave), `packages/ui/src/styles.css`

## Acceptance criteria
- [ ] Flags off → no affordance; on → panel opens/drags/collapses/reopens with thread intact (case:board-chat-01)
- [ ] Skill pills + chips populate input; free text posts to command mode (case:board-chat-02)
- [ ] Proposal batches render in-thread with per-item + batch accept controls
- [ ] `model: 'absent'` banner shows; everything else works (case:board-chat-13 UI half)
- [ ] <900px: proposal list mode fully usable (case:board-chat-12 UI half)
- [ ] Second client sees thread updates via SSE refresh (case:board-chat-11 UI half)
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None — consumes wp-161 api.ts + wp-164 routes.
