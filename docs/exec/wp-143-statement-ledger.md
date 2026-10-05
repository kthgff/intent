---
schema: 1
id: wp-143
title: Statement Ledger — semantic_statements, extraction pipeline, typed relations
status: done
priority: high
depth: deep
repos: []
wave: W19
depends_on: [wp-131]
---

## Description
PRD §15.3 core: `semantic_statements`/`statement_versions`/
`statement_relationships`/`statement_clarifications`/
`statement_decisions`/`statement_artifact_links`/
`semantic_extraction_runs` (wp-131 schema). A board note or interview
answer is the *evidence*; its meaning lives in atomic statements —
original text + source span preserved verbatim (never paraphrased),
dimensions intent/polarity/subject/strength/scope/status, confidence,
relations (`supports|contradicts|clarifies|duplicates|depends_on|
supersedes|derived_from`). Extraction stage (new `extract` agent stage
or extend interview): produces statements with `extraction_runs`
provenance (model/prompt version). Consequential interpretations →
confirmation requests; humans confirm, AI proposes. Authority rule:
retrieval finds; the structured model decides — an approved
`prohibits` beats a brainstormed `want` every time (fail-closed on
status resolution, per INTELLIGENCE §5).

## File ownership
`packages/conductor/src/semantics/**` (new), `packages/store/src/pg.ts`,
`packages/core` statement schemas, `packages/lints` (negation/qualifier
preservation checks)

## Acceptance criteria
- [ ] One note → N statements; original text + span always recoverable
- [ ] Typed relations + authority resolution tested (approved wins)
- [ ] Consequential statement → confirmation request, not silent truth
- [ ] Extraction provenance recorded per statement version
- [ ] Store + conductor tests green

## Contract change
None beyond wp-131.
