---
schema: 1
id: wp-132
title: Vocabulary rename — project→Solution, prd→rs, +Solution Brief, +Verification Spec
status: todo
priority: medium
depth: standard
repos: []
wave: W16
depends_on: [wp-131]
---

## Description
Apply the adopted addendum naming (PRD §15.2). Rename the *vocabulary*:
`projects` concept → `solutions` in UI strings, prompts, docs, and new
code paths; `workspace` remains the internal partition key (no storage
rename). Doc kinds: `prd.md` → `rs.md`, `test.md` → `vs.md`; migrate
existing `doc_versions` rows in 0001 (pre-release). New doc kinds
`solution-brief.md` (Solution scope, from wp-131) and `retro.md` wire
into prompts/templates. Stage names `prd`/`testplan` keep internal ids
(low-churn) but prompt templates + UI labels switch vocabulary. Update
`docs/*.md` references where they describe user-facing behavior;
binding internals may keep old names with a mapping note.

## File ownership
`packages/core/templates/**`, `packages/prompts/**`, `packages/ui/**`
strings, `docs/**` (vocabulary sweep), `packages/api` route labels

## Acceptance criteria
- [ ] No user-facing surface says "PRD"/"project" where the new vocab applies
- [ ] `rs.md`/`vs.md`/`solution-brief.md`/`retro.md` resolve through doc_versions
- [ ] Prompt token tables updated; `pnpm typecheck && pnpm test` green
- [ ] Mapping table old→new recorded in SCHEMAS.md appendix

## Contract change
Doc-kind rename is contract-level — flagged.
