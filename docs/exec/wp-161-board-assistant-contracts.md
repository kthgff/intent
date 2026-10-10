---
schema: 1
id: wp-161
title: Board Assistant contracts — proposal enums/schemas, Store iface, migration 0015, event names, ui.board_chat flag
status: done
priority: high
depth: standard
repos: []
wave: W24
depends_on: []
---

## Description
BOARD-CHAT-PRD/TDD (docs/design/BOARD-CHAT-*.md) — contract layer for
the Board Assistant feature. Lands FIRST in wave W24 (parallel-agent
rule: later tickets code against these landed interfaces). Adds to
core: `BOARD_PROPOSAL_OPS` (`create-item|patch-item|move-item|serve|
connect|connector-remove|delete-item`), `BOARD_PROPOSAL_STATUSES`
(`pending|accepted|rejected|stale|superseded`), `BoardProposalRowSchema`,
`ProposalOpSchema` (zod discriminated on `op` — payload shapes per TDD
op table), `ConverseOutputSchema` (`{reply, ops[]}`), `CompletionProvider`
type (`{converse(messages, opts): Promise<string>}` — the seam the TDD's
contract amendment 4 defines). Store iface: `upsertBoardProposal`,
`getBoardProposal`, `listBoardProposals({workspace, board, status?})`,
`supersedePendingProposals({board, op, itemId})`. Migration
`0015_board_chat.sql`: `CREATE TABLE board_proposals` (columns per TDD
data-model block, PK `(workspace, proposal_id)`, index
`(workspace, board, status)`) + `ALTER TABLE interview_messages ADD
COLUMN created_by TEXT` (nullable). Postgres impl + `created_by`
passthrough on message writes. Event union +=
`'board_proposal'`/`'assistant_message'`/`'proposal_created'`/
`'proposal_resolved'` per TDD (exact set as the TDD names — reconcile
`StreamEvent.type` vs `EVENT_NAMES` usage in deps.ts). `ui.board_chat:
false` flag in the `ui:` config section (requires `idea_canvas_v2`).
`packages/ui/src/api.ts`: typed client fns for the whole TDD REST table
+ `BoardProposal`/`ConverseOutput`/panel-payload types — UI tickets
build against these signatures.

## File ownership
`packages/core/src/enums.ts`, `packages/core/src/schemas.ts`,
`packages/core/src/store.ts`, `packages/core/src/config.ts`,
`packages/store/migrations/pg/0015_board_chat.sql`,
`packages/store/src/pg.ts`, `packages/conductor/src/loop/deps.ts`
(event union only), `packages/ui/src/api.ts`

## Acceptance criteria
- [ ] `board_proposals` table + `interview_messages.created_by` migrate clean (PGlite test)
- [ ] `ProposalOpSchema` rejects malformed ops (fail-closed) — per-op fixtures
- [ ] Store proposal CRUD + supersede covered by pg store tests
- [ ] `StreamEvent`/event-name union includes the new assistant/proposal events
- [ ] `ui.board_chat` parses in config (default false)
- [ ] `api.ts` exports typed fns for all 8 TDD routes
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
DB-SCHEMA.md `board_proposals` + `interview_messages.created_by`;
SCHEMAS.md proposal enums/schemas; SETTINGS.md `ui.board_chat` —
backport same PR.
