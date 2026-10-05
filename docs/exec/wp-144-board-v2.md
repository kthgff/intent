---
schema: 1
id: wp-144
title: Board v2 — typed notes, board types, multi-board + org boards, deferred-idea retention
status: todo
priority: high
depth: standard
repos: []
wave: W19
depends_on: [wp-131, wp-143]
---

## Description
PRD §15.3 surface: `board_items` gains the typed-note taxonomy
(`idea|want|avoid|problem|constraint|question|decision|feedback` +
`topic`/`importance`/`applies_to`/`note_status`/`rationale` fields) on
top of existing `kind`. `boards` gains `board_type` config
(`new-project|import|enhancement|modernization|quality|feedback|
release-planning|exploration`) — one board engine, per-type input/
capability/output/approval-policy config, not separate pipelines.
Multiple boards per workspace + org-level boards (`workspace`-scoped
`org` boards for unassigned ideas — a board can spawn a new workspace
and keep provenance). Board lifecycle `draft|discovery|proposal-ready|
approved|deferred|archived`; deferred boards retain all evidence and
can be re-surfaced (AI proposal only). Boards reference approved RS
items without mutating them — changes arrive as ChangeSets (wp-140).
Clustering/duplicate suggestion via embeddings + statements.

## File ownership
`packages/store/src/pg.ts`, `packages/api` board routes,
`packages/conductor/src/semantics/**`, `packages/core` board schemas

## Acceptance criteria
- [ ] Typed notes + per-type board config live
- [ ] Multi-board + org-level boards with spawn-provenance
- [ ] Referencing approved items never mutates them (ChangeSet path)
- [ ] Deferred boards re-surface as proposals
- [ ] `pnpm test` green

## Contract change
None beyond wp-131.
