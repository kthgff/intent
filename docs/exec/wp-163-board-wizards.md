---
schema: 1
id: wp-163
title: Board wizard catalog — board-generic + board-<type> configs, coverage seeding
status: done
priority: medium
depth: standard
repos: []
wave: W24
depends_on: [wp-161]
---

## Description
BOARD-CHAT-TDD "Board wizard configs". Registers one wizard per
`BOARD_TYPES` value (`board-new-project`, `board-feedback`,
`board-import`, `board-enhancement`, `board-modernization`,
`board-quality`, `board-release-planning`, `board-exploration`) plus
`board-generic` for NULL `board_type`. Shared slot shape per the TDD
table — required `goals` (asked first, impact 1.0; accepts
`want`/`requires`), `problems`, `wants`, `constraints`; optional
`avoids`, `open-questions`, `decisions`; per-type extras
(`board-feedback`: themes/severity; `board-import`: source-fidelity;
`board-release-planning`: targets/cut-criteria). Slots version with
`wizard_versions`; in-flight runs keep their version (existing engine
rule). `seedBoardWizards` registers lazily at session start via the
`seedMvpWizards`-style path (GETs stay read-only). `seedBoardSlots`
upgrades `missing → inferred` where the board already covers a slot —
coverage is deterministic: `goals` covered when ≥1 item is a `serves`
target, `problems` when ≥1 `problem` note exists, etc. (TDD mapping).

## File ownership
`packages/conductor/src/interview/wizard.ts`,
`packages/conductor/test/wizard*.test.ts` (or assistant-adjacent test
file per existing convention)

## Acceptance criteria
- [ ] Every `BOARD_TYPES` value + `board-generic` resolves a versioned wizard
- [ ] Seed is idempotent + lazy (no writes on GET paths)
- [ ] `seedBoardSlots` coverage: goals via serves-target, others via note_kind — unit-tested
- [ ] Per-type extra slots present on the right wizards only
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
Backport the goal-taxonomy resolution the TDD already names: goal-ness =
*being a `serves` target* (no `goal` note_kind; `isGoalItem` derives) —
one paragraph into SCHEMAS.md (item taxonomy) referencing D33 — same PR.
