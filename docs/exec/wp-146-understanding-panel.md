---
schema: 1
id: wp-146
title: Discovery readiness + Understanding Panel API + findings→revise loop
status: todo
priority: medium
depth: standard
repos: []
wave: W19
depends_on: [wp-145]
---

## Description
Discovery Completeness Engine (PRD §15.3): explainable readiness
report — unresolved high-impact questions, unconfirmed constraints,
untestable statements, contradictions, missing roles — no opaque
percentage. `GET /interview/:session/understanding` → confirmed /
inferred / unresolved / decision-required buckets (feeds the UI
Understanding Panel, wp-147). RS/artifact generation refuses to
produce unsupported binding requirements — every generated element
carries `artifact_source_links` to statements; the check is a lint,
not a vibe. Also the §14.2.1 findings→revise loop: spec-score findings
are selectable → "generate revised draft" produces a new doc_version
targeting selected findings, leaving others as open gate items.

## File ownership
`packages/api` understanding/readiness routes,
`packages/conductor/src/interview/**`, `packages/lints`
(artifact-source-link lint)

## Acceptance criteria
- [ ] Readiness report is explainable indicators, not a score
- [ ] Generated artifact elements each carry source links (lint enforced)
- [ ] Findings→revise produces a targeted new doc_version
- [ ] `pnpm test` green

## Contract change
None.
