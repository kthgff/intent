---
schema: 1
id: wp-158
title: Discovery E2E — board → statements → interview → RS → approve → tickets
status: todo
priority: high
depth: standard
repos: []
wave: W23
depends_on: [wp-143, wp-144, wp-145, wp-146]
---

## Description
Discovery-side vertical: seed board with typed notes → extraction
produces statements w/ provenance → interview session fills knowledge
slots (draft_ready vs approval_ready paths) → Solution Brief → RS draft
(every element source-linked) → spec_score → human approve → ChangeSet
diff → tickets generated with contracts. Cover the fail-closed paths:
unsupported binding requirement rejected, conflicting statements →
decision item, unanswerable question → routed not re-asked, deferred
board re-surfaced as proposal. Mock adapter drives agent stages.

## File ownership
`packages/conductor/test/**`, `packages/api/test/**`, `fixtures/**`

## Acceptance criteria
- [ ] Full discovery→approved-RS vertical green
- [ ] Each fail-closed path covered by a test
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None.
