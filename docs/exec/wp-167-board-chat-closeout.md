---
schema: 1
id: wp-167
title: Board Assistant close-out — skills polish, a11y, e2e acceptance, docs backport
status: done
priority: medium
depth: standard
repos: []
wave: W24
depends_on: [wp-162, wp-163, wp-164, wp-165, wp-166]
---

## Description
Wave close-out for BOARD-CHAT. (1) **Skills polish**: `/expand`
selection-scoping edge cases (zone-only selection, mixed selection,
no-selection inert pill explanation); `/critique` LLM findings merging
with deterministic checks without duplication; `/interview end`
natural-language equivalents. (2) **A11y pass** per TDD: `aria-live`
announcements for assistant turns + proposal batches, `Esc` collapse,
`/` focus, focus-return on collapse, keyboard-reachable proposal
actions, `prefers-reduced-motion`. (3) **E2E/acceptance**: cover the
PRD's 13 `case:board-chat-*` rows — map each to the cheapest honest
level (unit/integration/api/UI) and record the mapping in the ticket;
the live-provider path is covered by a stubbed provider, never a real
OpenRouter call in tests. (4) **Docs backport** (parallel-agent rule +
AGENTS.md spec-gap rule): `API.md` assistant routes + `board_proposal`
SSE event; `DB-SCHEMA.md` `board_proposals` + `created_by` (if wp-161
didn't land it); `SCHEMAS.md` proposal enums + goal-ness resolution (if
wp-163 didn't); `SETTINGS.md` `models.assistant` + `ui.board_chat` (if
wp-164/161 didn't); PRD + TDD `Status: proposed` → implemented with a
dated note; TRACKER rows → done; decision-log entry recording the LLM
choice (Qwen3-30B-A3B-Instruct-2507 via OpenRouter through the wp-155
registry; OpenRouter-only v1 — self-hosted endpoint override is a
follow-up).

## File ownership
Any BOARD-CHAT file (close-out sweep) + `docs/API.md`,
`docs/DB-SCHEMA.md`, `docs/SCHEMAS.md`, `docs/SETTINGS.md`,
`docs/design/BOARD-CHAT-{PRD,TDD}.md` status lines, `docs/TRACKER.md`

## Acceptance criteria
- [ ] All 13 PRD acceptance cases covered and the mapping recorded
- [ ] A11y checklist items verified
- [ ] Docs backport complete — no spec/code drift left from the wave
- [ ] Decision log entry: provider/model/registry-kind decision recorded
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green on the whole repo

## Contract change
Consolidated docs backport (this ticket owns whatever earlier tickets
missed — flagged in review, not silently skipped).

## Completion record (2026-10-09)

**Acceptance-case map** (PRD `case:board-chat-*` → cheapest honest level):

| Case | Covered at | Where |
|---|---|---|
| 01 flags + panel open/collapse/reopen | UI | `ui/test/assistant-panel.test.tsx` (flag-off → no affordance/fetch; toggle→open→collapse→reopen) |
| 02 pills/chips → input; freeform → command | UI | `assistant-panel.test.tsx` (chip→input, `{workspace,text}` POST) |
| 03 /interview → goals question → ghost stickies + provenance | engine + API + UI | `conductor/test/assistant.test.ts` (goals-first ask, create-item drafts); `api/test/board-assistant.test.ts` (interview round-trip); `board-canvas-ghost.test.tsx` + `assistant-panel.test.tsx` (proposals→ghost prop) |
| 04 accept via legality/OCC; reject; atomic batch | engine + API | `assistant.test.ts` (accept/stale/batch-atomic); `board-assistant.test.ts` (409→stale) |
| 05 goals never re-asked; weakest coverage next | engine | wp-163 wizard tests (goals slot first; coverage-driven planner) |
| 06 contradiction → decision + supersede | engine | `assistant.test.ts` (decision-intent extraction; `supersedeForDecision`) |
| 07 /expand scoped + inert without selection | engine + UI | `assistant.test.ts` (zone-only → explains; mixed → filtered scope); `assistant-panel.test.tsx` (inert pill) |
| 08 /critique findings, zero writes | engine + API | `assistant.test.ts` (findings, no proposals; LLM merge dedup); `board-assistant.test.ts` |
| 09 op legality incl. entity-ref move-only | engine + API | `assistant.test.ts` (delete-refuses-consumed, connect-refuses-self-link); API proposal accept tests |
| 10 end run → readiness summary (+synthesis chip) | engine + API | `assistant.test.ts` (`endRun` summary); `board-assistant.test.ts` (runs round-trip); chips (`synthesize` stripped — route not live) |
| 11 second client sees thread + ghosts via SSE | API + UI | `board-assistant.test.ts` (interview_updated + board_proposal post-write); `sse.ts` `board_proposal` + `useStreamRefresh` |
| 12 <900 px list mode; stale-base 409 | UI + API | `assistant-panel.test.tsx` (in-thread list — no canvas dependency); `board-assistant.test.ts` (OCC 409→stale) |
| 13 no provider → deterministic + banner | engine + UI + API | `assistant.test.ts` (`model:absent`, NO_PROVIDER_REPLY); `assistant-panel.test.tsx` (banner); `board-assistant.test.ts` (provider-absent paths) |

**A11y checklist** (TDD §Accessibility) — all verified in
`AssistantPanel.tsx`/`IdeaBoard.tsx`: `aria-live="polite"` announce span
(new turns + proposal counts); `Esc` collapses; `/` focuses the input
(`isEditableTarget` guard); focus returns to the corner toggle on
collapse (`toggleRef`); proposal accept/reject/accept-all are real
`<button>`s (keyboard-reachable, no drag dependency below 900 px or
anywhere); `prefers-reduced-motion` zeroes panel transitions AND the
`setCenter` deep-link duration; skill pills are real buttons with
prerequisite tooltips.

**Skills polish landed**: `/interview end` + natural equivalents
(`end the interview`, `i'm done`, …) close the active run ahead of the
pending-question route; `/expand` scope filters to content items —
zone-only selections explain in-thread rather than branching;
`/critique` merges provider findings via `llmCritiqueFindings` (closed
kind set, deduped on kind+item+detail, unknown item_ids dropped,
malformed → deterministic floor only, `·model` provenance tag).

**Docs backport**: API.md assistant routes + `board_proposal` SSE +
`active_run` (wp-164/165); DB-SCHEMA `board_proposals` + `created_by`
(wp-161); SCHEMAS goal-ness D33 (wp-163); SETTINGS `models.assistant`
Qwen/OpenRouter example + `ui.board_chat` (wp-164/161); PRD+TDD status
→ implemented; TRACKER D54 records the provider/model/registry decision.

**Verification**: `pnpm typecheck` green repo-wide; `conductor`
assistant suite 35/35, `api` board-assistant 18/18 (full api suite
171/171), `ui` suite 139/139 (panel 10/10). Pre-existing failures
outside this wave's ownership: `conductor/test/container-conductor` 1
Docker-inspect flake; repo-wide `pnpm lint` had 26 errors in older
Easy Edit/annotations/overlays work elsewhere in the same tree; `store`
has 2 `listProjectSummaries`
failures from concurrent uncommitted work.
