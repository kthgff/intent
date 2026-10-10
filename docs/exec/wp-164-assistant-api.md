---
schema: 1
id: wp-164
title: Board Assistant API + OpenRouter provider — REST surface, SSE, registry kind 'assistant'
status: done
priority: high
depth: standard
repos: []
wave: W24
depends_on: [wp-161, wp-162]
---

## Description
BOARD-CHAT-TDD "REST surface" + contract amendment 4 (as amended for
the wp-155 routing registry — see TDD). Two halves:

**Provider.** `packages/api/src/openrouter.ts` — thin OpenAI-compatible
chat-completions client (`fetch`, `https://openrouter.ai/api/v1/
chat/completions`, `Authorization: Bearer <OPENROUTER_API_KEY>` from
`deps.config.secrets` — never logged, never in config). Resolved at
server start: `resolveModelRoute(config, 'assistant')` → RouteDecision;
missing key or unresolved model → `CompletionProvider` is `undefined`
(every consumer degrades per PRD R10). Model id is passed through as
the registry resolved it (already `openrouter/<org>/<model>`-free —
registry stores bare ids like `qwen/qwen3-30b-a3b-instruct-2507`).
`response_format: {type:'json_schema'}` on structured turns when
`schema_required`; caller-side zod re-validation stays authoritative
either way. No streaming (PRD non-goal); one completion per converse
turn, interview turns ≤3 (planner+extract+converse budget, TDD perf
section). `assertRouteProvider(route, 'openrouter')` honored — a route
pinned to other providers errors loudly at wiring time.

**Routes.** `packages/api/src/board-assistant.ts` — the full TDD table:
`GET …/assistant` (one-load panel state incl. `model: configured|absent`),
`POST …/assistant/messages`, `POST …/assistant/runs`,
`POST …/assistant/runs/:branch/end`, `GET …/proposals`,
`POST …/proposals/:id/accept`, `POST …/proposals/:id/reject`,
`POST …/proposals/accept` (batch). Bodies zod-strict; errors through
existing `call()`/`ApiError`; every mutation emits SSE
(`interview_updated` existing + new proposal/message events) AFTER the
durable write. `server.ts` registers the router; run-end
`{action:'run_synthesis'}` hidden when the scoped-synthesis route isn't
live.

## File ownership
`packages/api/src/board-assistant.ts` (new),
`packages/api/src/openrouter.ts` (new), `packages/api/src/server.ts`,
`packages/config` (registry kind doc/`models:` parsing if needed —
registry keys are free-form so likely none), `packages/prompts`
(`KIND_LATENCY_DEFAULT['assistant']='interactive'` if kind constants
live there)

## Acceptance criteria
- [ ] All 8 routes live; happy-path + fail-closed bodies covered by api tests
- [ ] Provider absent → GET reports `model: 'absent'`; endpoints still work deterministically
- [ ] Provider present (stubbed fetch) → converse turn flows; malformed JSON → zero ops + explanatory reply
- [ ] SSE emitted post-write only; `board_proposal` event carries `{workspace, board, proposal_id, status}`
- [ ] No live OpenRouter calls in tests — client injected/mocked
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
API.md assistant/proposal routes; SETTINGS.md `models:` example
(`assistant.primary: qwen/qwen3-30b-a3b-instruct-2507`,
`providers: [openrouter]`, `max_output_tokens`) — backport same PR.
