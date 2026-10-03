---
schema: 1
id: wp-031
title: State machine — sentinel→transition table, gate items, events.jsonl
status: done
status: in-progress
priority: high
depth: deep
repos: []
wave: W3
depends_on: [wp-030]
---

## Description
Encode CONDUCTOR.md's full sentinel→transition table as data (not
if-chains): every row — run type, sentinel, action. Actions mutate
ticket frontmatter (status commit), create gate_items, emit
events.jsonl entries (SCHEMAS §7 event names), regenerate LOG.md.
Auto-advance chains incl. the `in-progress` spend-checkpoint exception
and gate modes (full|plan-package|minimal compress which gates fire).
Split materialization, suggestions application, stale-spec check,
needs-info rounds cap (3).

## File ownership
`packages/conductor/src/{transitions,gates,events}/**`

## Acceptance criteria
- [ ] Table-driven: adding a sentinel row changes behavior, no code edit
- [ ] Every event in SCHEMAS §7 enum is emitted somewhere (coverage test)
- [ ] Gate modes produce correct gate_item subsets per config
- [ ] events.jsonl append + LOG.md regeneration are atomic per commit

## Notes (implementation decisions — wp-031)

Delivered in `packages/conductor/src/{transitions,gates,events}/`:

- `transitions/table.ts` — CONDUCTOR's sentinel→transition table as
  data (`TRANSITION_TABLE`; each row carries its spec cell). Dispatch
  is by (stage, sentinel, payload) → action id; a row addition needs
  only an `ActionId` + entry in `RealTransitionHandler.#actions`.
- `transitions/handler.ts` — `RealTransitionHandler` (drop-in for the
  frozen wp-030 seam; constructor takes `EffectiveConfig` for gate
  mode / auto_fix_rounds / auto_fix_severities / escalation_model).
- `transitions/actions.ts` — special paths: suggestions application,
  split materialization, stale-spec hash, review-merge (§6
  fingerprints/thread_ids via `packages/lints`).
- `gates/index.ts` — gate-mode compression (`full|plan-package|minimal`).
- `events/index.ts` — §7 event emit funnel + LOG.md regen.

Ambiguities resolved (no seam extension needed — `TransitionTools`
covered everything):

1. **needs-info cap**: 3 full Q&A rounds are allowed; the *4th*
   `NEEDS-INFO` escalates (counted from triage runs ending NEEDS-INFO).
2. **Suggestions**: a frontmatter field is "human-set" when it holds a
   value ≠ the last applied suggestion; applied values are recorded
   under `suggested_<key>:` so later re-triage can update machine-owned
   fields while human edits always win.
3. **Gate modes**: `repair` + `escalated` items surface in EVERY mode
   (fail-closed — suppressing them strands tickets invisibly).
   `minimal` surfaces needs-info, design-qa, changes-requested,
   approved. `plan-package` = that set + one `plan-package` review gate
   surfaced at `test-review` (the prd/tdd/test docs all exist by then;
   the test-approved spend checkpoint folds into the package approval).
4. **Split-plan reject**: `gate_items` carries no decision field —
   clearing + a `gate_overridden` event (data.gate='split-plan') =
   reject (ticket returns to triage); clearing alone = approve →
   materialize (children ids via next-id CAS, `split_materialized`).
5. **spec_hash**: baseline is stored in ticket.md frontmatter
   (`spec_hash:`) at `test-approved` — the projection's spec_hash
   column covers ticket.md alone. Missing baseline → recorded lazily,
   never blocks.
6. **Review passes**: serialize through the (subject,stage) pending-run
   dedup — verify DONE queues pass 1, each PASS-COMPLETE merges
   `findings-<pass>.json` into review.json and queues the next pass.
   PASS-COMPLETE with no fragment is malformed → retry ladder.
7. **ci-watch cleared** → `merged`, or `reverted` when the ticket has a
   completed revert run. Merge itself never auto-fires — a cleared gate
   means the human already merged.
8. **Probe cards**: persisted to `.sprint-runner/cards/<repo>.json` in
   the tickets repo (durable copy of the code repo's card.json +
   verified bit).
9. **Interview-qa re-run**: interview subjects aren't ticket-driven —
   the gate-clear path (API wp) queues the re-run; noted in the action.
