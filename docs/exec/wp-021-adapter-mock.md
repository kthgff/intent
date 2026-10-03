---
schema: 1
id: wp-021
title: Adapter interface impl — mock backend (scripted sentinels)
status: todo
priority: high
depth: standard
repos: []
wave: W2
depends_on: [wp-020]
---

## Description
Implement the `Adapter` contract as a **mock backend** for tests/E2E:
`run()` spawns a real detached child process (a node script) that
writes scripted artifacts to ARTIFACT_TARGETS, optionally emits
usage_partial lines, sleeps a configurable delay (heartbeat coverage),
and prints the scripted sentinel as its last line. Scenario scripting
via env/args: `DONE`, `BLOCKED:`, `NEEDS-INFO:`, garbage-sentinel,
timeout-never-exits, artifact-lint-fail. This is the harness the whole
conductor test-suite runs against — real process semantics, no real LLM.

## File ownership
`packages/adapters/src/{interface-impl,mock}/**` (iface may already
exist in core — this wp is the first concrete impl)

## Acceptance criteria
- [ ] RunHandle gives real pid + log_path; control(kill|pause|resume) works
- [ ] collect() parses last-non-empty-line sentinel + usage correctly
- [ ] Scenario: truncated log mid-run → missing sentinel detected
- [ ] Conductor devs can drive the full pipeline with zero API spend
