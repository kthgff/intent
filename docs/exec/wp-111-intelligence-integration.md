---
schema: 1
id: wp-111
title: Intelligence integration — grounded PRDs, quality, traceability, impact, and tests
status: todo
priority: high
depth: deep
repos: []
wave: W13
depends_on: [wp-110, wp-081]
---

## Description

Integrate D37 Phase A evidence into the product workflow. Existing-product PRD
runs retrieve code/dossier evidence before drafting; greenfield and zero-result
paths are explicit. Add a cited AI PRD-quality pass without replacing the
deterministic `spec_score`. Supply scoped evidence to design/impact, testplan,
implement, and review. Persist explicit workflow links as verified and model
links as suggested; let humans verify/reject suggestions with provenance.

Extend existing ticket/document/KB/review surfaces rather than adding a new
chat-first experience. Every claim opens its source at the pinned version; stale
evidence is labeled and cannot verify an AC.

## File ownership

`packages/core/**`, `packages/conductor/**`, `packages/prompts/**`,
`packages/api/**`, `packages/ui/**`, `packages/lints/**`, `docs/prompts/**`

## Acceptance criteria

- [x] Existing-product `prd-draft` obtains and validates a scoped evidence bundle before prompt rendering; greenfield/zero-result behavior is explicit
- [x] PRD quality findings cover ambiguity, contradiction, failure paths, accessibility, abuse/security, privacy/data, performance, operability, observability, rollout, rollback, and success measurement with citations
- [x] The AI quality pass never auto-approves a PRD and does not replace or alter deterministic `spec_score`
- [x] Design/test/implement/review prompts receive task-bounded evidence; implement/review still read current worktree files and run real commands
- [x] Goal/AC/ticket/PR/commit/code/test links show provenance, verification, confidence, and source version; suggested links cannot masquerade as verified
- [x] Human verify/reject actions are idempotent, evented, and exposed through the API/UI
- [x] Stale or unauthorized evidence cannot mark an AC/link verified
- [x] Source citations are navigable from document and review findings
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

## Test plan

- Run one existing-product and one greenfield fixture through PRD→review;
  assert pre-PRD ordering, evidence artifacts, and graceful zero-result path.
- Seed a missing abuse control, rollback step, and test gap; verify cited quality
  findings and no automatic doc/gate mutation.
- Verify/reject the same suggested link concurrently; assert one event/state
  transition and a `409` for stale writes.
- Advance a repo head between design and implement; assert stale evidence is
  re-retrieved or explicitly held per settings.

## Definition of Done

- [x] Existing S-05/S-06/S-08/S-14 designs document evidence interactions
- [x] No new opaque readiness score or permanent AI-chat chrome introduced
- [x] Retrieval evaluation includes the integrated task queries
- [x] Relevant prompt contracts and fixtures are versioned


## Completion notes (wp-111 close-out)

- UI wiring: `Traceability` mounts as a TicketFocus tab; `RsQualityPanel`
  mounts in DocReview's rail when the resolved doc is `rs.md` (all
  findings) and in the `rs-quality` gate card in TicketFocus (criticals
  only + human `waive_quality` action → `gate_overridden`; never an
  approval).
- Spec gap resolved + backported to API.md: doc routes accept legacy
  aliases `prd`/`prd.md`→`rs.md` and `test`/`test.md`→`vs.md` because
  stage/gate ids kept pre-rename vocabulary (wp-132). Stale UI doc names
  (`prd`/`test`) in TicketFocus/Inbox were updated to `rs`/`vs`.
- Assumption: the wp-111 task-eval golden fixture lives under
  `fixtures/kb/` (not `fixtures/eval/`) — `loadGoldenCorpus` treats every
  `*.json` in `fixtures/eval/` as a lints golden family, which this
  retrieval suite is not.
