---
schema: 1
id: wp-112
title: Continuous alignment and evidence-backed release readiness
status: todo
priority: medium
depth: deep
repos: []
wave: W14
depends_on: [wp-111]
---

## Description

Implement D37 Phase B: compare intended (goal/PRD/AC/TDD/test), implemented
(code/PR/commit/release), and verified/observed (tests/CI/verification) evidence
to produce `alignment-findings.json`. Add an evidence-backed release-risk
narrative that is subordinate to deterministic gates, plus semantic clustering
for captured feedback. Findings are reviewable hypotheses only.

## File ownership

`packages/core/**`, `packages/store/**`, `packages/kb/**`,
`packages/conductor/**`, `packages/api/**`, `packages/ui/**`,
`packages/prompts/**`, `docs/prompts/**`

## Acceptance criteria

- [ ] Alignment emits the §18 schema for missing implementation evidence, unverified ACs, unlinked changes, likely drift, and affected approved behavior
- [ ] Every finding has evidence, confidence, freshness, next check, and optional disconfirming evidence
- [ ] Findings cannot mutate specs, verify links/ACs, clear release gates, or create tickets without human action
- [ ] Release readiness distinguishes deterministic pass/fail gates from the AI risk narrative; narrative cannot override a failed gate
- [ ] On-merge mode coalesces duplicate scope/SHA runs and honors configured token/spend limits
- [ ] Feedback clustering preserves original refs and proposes—not silently creates—board/initiative work
- [ ] Delivery metrics aggregate team/system outcomes only; no individual developer ranking exists
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

## Test plan

- Fixtures for each finding kind, a clean aligned case, stale evidence, and
  contradictory evidence; assert claims remain hypotheses.
- Failed test/DoD gate plus optimistic risk narrative; assert release remains
  blocked. Green gates plus high-risk narrative; assert human sees both.
- Duplicate on-merge events; assert one alignment run and durable artifact.
- Similar feedback from two authorized projects; assert clusters do not cross
  workspace scope.

## Definition of Done

- [ ] Alignment and release-readiness golden-set baselines recorded
- [ ] UI supports inspect/dismiss/verify/resolve without hiding evidence
- [ ] All mutations write events and preserve original findings

