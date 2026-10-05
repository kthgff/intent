---
schema: 1
id: wp-145
title: Interview Orchestrator — wizard defs, knowledge slots, question planner, snapshots
status: todo
priority: high
depth: deep
repos: []
wave: W19
depends_on: [wp-131, wp-143]
---

## Description
PRD §15.9 core engine. `wizard_definitions`/`wizard_versions`
(versioned knowledge requirements as config, not code),
`interview_sessions`/`interview_branches`/`interview_messages`/
`knowledge_slots`/`question_candidates`/`session_snapshots`
(wp-131 schema). Orchestrator = deterministic control (permissions,
session state, slot states `known|inferred|missing|conflicted|na|
deferred`, required confirmations, schema validation, stopping
conditions) + LLM assist (interpret answers → statements via wp-143,
propose next question). Question planner: deterministic eligibility →
AI proposal scored on impact×uncertainty×relevance + answerability +
effort; "user can't answer" is a first-class outcome (route/record/
unresolved — never re-ask). Never emit a next question before the
prior answer is durably persisted. Two thresholds: `draft_ready` vs
`approval_ready`. Snapshots: resumable sessions + knowledge-version
diff briefing on resume. Multi-stakeholder branches merge statements
preserving attribution; disagreement → decision item.
Three MVP wizard configs: solution-discovery, requirements-discovery,
tdd-discovery.

## File ownership
`packages/conductor/src/interview/**` (new), `packages/core` wizard/
slot schemas, `packages/api` interview session routes

## Acceptance criteria
- [ ] Slot state machine + adaptive question planner work end-to-end
- [ ] Answer-before-question persistence ordering enforced
- [ ] draft_ready ≠ approval_ready
- [ ] Resume shows a change briefing; branches merge with attribution
- [ ] Wizard golden-set tests (extraction precision, no repeats, no
  unsupported binding statements)

## Contract change
None beyond wp-131.
