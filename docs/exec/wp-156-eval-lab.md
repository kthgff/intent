---
schema: 1
id: wp-156
title: AI Evaluation Lab — golden sets, bake-off harness, promotion gates
status: todo
priority: medium
depth: standard
repos: []
wave: W22
depends_on: [wp-155, wp-143]
---

## Description
PRD §15.12 eval: golden-set framework per task family (statement
extraction incl. negation/qualifier cases, question usefulness, RS
draft fidelity, unsupported-binding-requirement rate, code review true
/false-positive rate, requirements coverage). `retrieval_evaluations`
extends to `eval_runs`/`eval_cases`/`eval_results` tables (wp-131).
Bake-off runner executes candidate models against golden sets,
records model+prompt version+policy version+scores. Promotion gate:
a routing-registry change requires golden-set pass (quality floor
stricter for security/requirements tasks). Regression rerun triggers
on model/prompt/provider change. Wizard metrics wired: repeat-question
rate, correction rate, unnecessary-question rate, artifact-fidelity.

## File ownership
`packages/lints/eval/**` (new), `fixtures/eval/**`, `packages/store`,
`packages/config` eval config

## Acceptance criteria
- [ ] Golden sets per family run offline (mock or recorded fixtures)
- [ ] Promotion gate blocks a failing candidate from registry
- [ ] Wizard metrics emitted per session
- [ ] `pnpm test` green

## Contract change
Eval tables land in wp-131.
