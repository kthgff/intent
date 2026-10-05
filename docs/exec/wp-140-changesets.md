---
schema: 1
id: wp-140
title: ChangeSets — lifecycle, versioned spec diffs, apply/reconcile (PRD §15.5)
status: done
priority: high
depth: deep
repos: []
wave: W18
depends_on: [wp-131]
---

## Description
`changesets` + `changeset_items` (wp-131 schema) implementing the
lifecycle `draft → analyzing → awaiting_decision → approved|deferred|
rejected → applying → verified`. A ChangeSet carries: original request
text, baseline ref (subject + doc + version), classification
(`clarification|correction|addition|modification|removal`), affected-
artifact analysis (from `relations` + semantic statements when wp-143
lands), proposed doc diffs (new `doc_versions`, never in-place), human
decision, and reconciliation results. Apply = transactional doc_version
appends + `spec_hash` updates + impact events. Decision options are
first-class: `add-now | swap-scope | next-release | decline` —
each carrying its consequence into affected releases (wp-134 link).
Emergency path: expedited decision + mandatory retro note. Conflicting
open ChangeSets on the same baseline are detected and serialized.
Approvals carry `expires_on` invalidation when material upstream
change lands.

## File ownership
`packages/conductor/src/changes/**` (new), `packages/store/src/pg.ts`,
`packages/core` changeset schemas (wp-131), `packages/api` changeset
routes (coordinate with wp-136 file map)

## Acceptance criteria
- [ ] Full lifecycle incl. transactional apply + partial-apply visibility
- [ ] Diffs are doc_versions — baselines immutable
- [ ] Decision options + conflicts + expiry all enforced
- [ ] Events `changeset_*` emitted; notification fan-out to affected owners

## Contract change
None beyond wp-131.
