---
schema: 1
id: wp-032
title: Doc lints — spec-lint scorer, coverage matrix, fail-closed validators
status: done
status: in-progress
priority: medium
depth: standard
repos: []
wave: W3
depends_on: [wp-031]
---

## Description
Mechanical checks run inline in the tick: **spec-lint scorer**
(underspecified in docs — FIRST write the rule set into SCHEMAS.md:
verifiable ACs, DoD presence, repos listed, no placeholder text,
description length thresholds → spec_score 0-100 → `{{SPEC_LINT}}` text);
**coverage-matrix lint** (TDD file-plan rows → ≥1 case_id, `untestable:`
exemption); **structured-doc lint** for agent-written artifacts
(fail-closed → doc-repair path); **file-plan-vs-diff check** (runner
diffs TDD plan vs `git diff --name-only` — feeds spec-compliance pass);
**fingerprint computation** for findings (file + category +
line-overlap + text_hash — document formula in SCHEMAS.md §6).

## File ownership
`packages/lints/**`, `docs/SCHEMAS.md` (rule backports)

## Acceptance criteria
- [x] spec-lint rules documented in SCHEMAS.md, implemented, unit-tested
- [x] Coverage lint: missing case_id fails closed; untestable row exempt
- [x] Fingerprint: same finding across shifted line numbers still matches
- [x] All lints pure functions: doc in → violations list out
