---
schema: 1
id: wp-112
title: Continuous alignment and evidence-backed release readiness
status: done
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

- [x] Alignment emits the §18 schema for missing implementation evidence, unverified ACs, unlinked changes, likely drift, and affected approved behavior
- [x] Every finding has evidence, confidence, freshness, next check, and optional disconfirming evidence
- [x] Findings cannot mutate specs, verify links/ACs, clear release gates, or create tickets without human action
- [x] Release readiness distinguishes deterministic pass/fail gates from the AI risk narrative; narrative cannot override a failed gate
- [x] On-merge mode coalesces duplicate scope/SHA runs and honors configured token/spend limits
- [x] Feedback clustering preserves original refs and proposes—not silently creates—board/initiative work
- [x] Delivery metrics aggregate team/system outcomes only; no individual developer ranking exists
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

## Test plan

- Fixtures for each finding kind, a clean aligned case, stale evidence, and
  contradictory evidence; assert claims remain hypotheses.
- Failed test/DoD gate plus optimistic risk narrative; assert release remains
  blocked. Green gates plus high-risk narrative; assert human sees both.
- Duplicate on-merge events; assert one alignment run and durable artifact.
- Similar feedback from two authorized projects; assert clusters do not cross
  workspace scope.

## Definition of Done

- [x] Alignment and release-readiness golden-set baselines recorded
      (`packages/conductor/test/wp112.test.ts` fixtures: every finding
      kind, clean aligned case, stale pins, contradictory evidence,
      blocked/green gate + narrative pairs — asserted as baselines)
- [x] UI supports inspect/dismiss/verify/resolve without hiding evidence
      (`packages/ui/src/Alignment.tsx` — all evidence_refs +
      disconfirming_refs render; OCC decisions via /alignment/decide)
- [x] All mutations write events and preserve original findings
      (`alignment_run_completed`, `alignment_finding_decided`,
      `feedback_cluster_proposed` events + append-only
      `alignment_finding_decisions` audit; re-runs never touch a
      settled status)

