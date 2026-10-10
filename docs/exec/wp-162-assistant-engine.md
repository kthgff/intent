---
schema: 1
id: wp-162
title: Board Assistant engine — thread/runs/proposals/placement/coverage/converse modules
status: done
priority: high
depth: deep
repos: []
wave: W24
depends_on: [wp-161]
---

## Description
BOARD-CHAT-TDD "turn pipeline" + "proposals lifecycle". New module
`packages/conductor/src/assistant/` implementing the whole deterministic
core; the LLM enters ONLY through the injected `CompletionProvider`
(undefined-safe — every path has a deterministic fallback per PRD R10):

- `thread.ts` — board session get-or-create:
  `sessionIdFor('board-<type>', 'board:<slug>')`, `mode: 'conversation'`;
  message append with `created_by` attribution; system run markers.
- `runs.ts` — `/interview`+`/expand` lifecycle on `interview_branches`
  (`run-N`, `role: 'interview'|'expand'`, `active → merged|abandoned`);
  optional subject scoping recorded as a system message; run-end posts
  the readiness summary (`evaluateReadiness` + coverage; `draft_ready`
  carries `{action:'run_synthesis'}`).
- `proposals.ts` — draft (per-turn item stream | checkpoint batch with
  `batch_id`), accept (per-op legality through the SAME single-item
  conductor write path manual edits use — kind/ref guards, status enum,
  `consumed|frozen` refuse, OCC fence on `base_updated_at`; creates
  stamp `provenance:'inferred'` + `statement_artifact_links`
  `artifact='board-item:<id>'`), reject, supersede-identical-pending,
  stale-on-409. Batch accept = one `store.transaction`.
- `placement.ts` — `computePlacement` pure fn per TDD ordering
  (zone cell → right-of-anchor → below-bbox; 32px grid collision nudge;
  deterministic, no LLM).
- `coverage.ts` — board coverage computation + `/critique` deterministic
  checks (vague/untyped/orphan/unanswered-question/missing-kind/
  no-goals/open-decisions).
- `skills.ts` — skill registry + `suggestChips` (pure: no serves-target →
  `Run /interview`; open decisions → `Resolve N`; `draft_ready` →
  synthesize chip).
- `converse.ts` — command-mode turn: board digest + recent turns →
  provider → `ConverseOutputSchema` fail-closed (malformed → zero ops,
  reply says so); one clarifying question on ambiguity, never a guess.
- Turn routing per TDD: pending asked question → `submitAnswer`;
  `/` → skills; freeform → converse. Extraction rides the existing
  `runExtraction`/`ingestExtraction` seams with verbatim fallback;
  statement-intent → note_kind map per TDD (incl. `goals`-slot
  statements producing `serve` ops); contradiction surfacing via
  `statement_decisions`.

## File ownership
`packages/conductor/src/assistant/**` (new),
`packages/conductor/test/assistant*.test.ts` (new)

## Acceptance criteria
- [ ] Full turn pipeline green with `provider: undefined` (deterministic paths) AND with a stub provider
- [ ] Accept executes through existing single-item legality; stale base → 409 + `stale`
- [ ] Batch accept is transactional (partial failure → nothing lands)
- [ ] `computePlacement` golden tests: zone/anchor/fallback + no-overlap invariant
- [ ] Contradicting answer → in-thread decision + `statement_decisions` row + supersede proposal
- [ ] Intent→note_kind map + goals-slot `serve` wiring covered
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None — implements wp-161 contracts. Spec-gap note (goal-ness =
serves-target) is documented by wp-163's wizard work; engine treats it
as a coverage rule only.
