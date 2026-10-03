---
schema: 1
id: wp-002
title: Contract freeze — port SCHEMAS/DB-SCHEMA/ADAPTERS to packages/core
status: in-progress
priority: high
depth: standard
repos: []
wave: W0
depends_on: [wp-001]
---

## Description
Translate the spec docs into TypeScript contracts in `packages/core`:
- zod schemas for: ticket frontmatter, events.jsonl events (SCHEMAS §7),
  review.json findings, triage.json, usage.json (§13), test-report.json,
  gate items, run registry rows, dossier sections, config.yaml (SETTINGS)
- enums: status state machine, sentinel strings (full table from
  CONDUCTOR.md), finding severities, run statuses, event names
- prompt templates: copy `docs/prompts/*.md` into the package as
  shipped assets + `PROMPT_VERSION` constant
- token table type: `PromptToken` union per ADAPTERS.md token table
- `Store` interface surface + `Adapter` interface (prepare/run/control/
  on_usage/collect per ADAPTERS.md) — signatures only, impls elsewhere

## File ownership
`packages/core/**` exclusively. No other package may be touched.

## Acceptance criteria
- [ ] Every structured artifact in SCHEMAS.md has a zod schema + inferred type
- [ ] Sentinel union covers every row of CONDUCTOR.md's transition table
- [ ] `Adapter` and `Store` interfaces compile with JSDoc citing spec sections
- [ ] PROMPT_VERSION exported; templates loadable via package API
- [ ] Unit tests: round-trip parse each schema against fixture docs
