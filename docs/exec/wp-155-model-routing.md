---
schema: 1
id: wp-155
title: Model Routing Registry — versioned task→model config, latency classes, cost-per-accepted metric
status: done
priority: medium
depth: standard
repos: []
wave: W22
depends_on: [wp-131]
---

## Description
PRD §15.12. Config `models:` registry — every AI interaction kind
(sticky-note tagging, atomic extraction, question gen, RS draft,
implement, review, security, notes, multimodal…) maps to
`{primary, fallback, max_output_tokens, schema_required, providers[],
eval_threshold}` in versioned YAML, never hardcoded in business logic.
Latency classes `instant|interactive|background` drive provider sort +
prompt budgets; interactive answers stream (no JSON-only on the
conversational path). Per-run model pinning via `runs.request` +
`model` column (already exists); mid-execution model switch requires a
recorded transition event. Bounded escalation: retries respect
per-ticket budget caps before escalating model tier — never automatic
premium escalation on failure. Metric: `cost_per_accepted_outcome`
computed from `usage_calls` + accepted-ticket events, exposed in
`/metrics`. BYOK stays the provider story; registry references
configured endpoints only.

## File ownership
`packages/config` models section + zod, `packages/prompts` routing
lookup, `packages/conductor` pinning + escalation policy,
`packages/api` metrics

## Acceptance criteria
- [ ] Every AI call site resolves through the registry (no hardcoded models)
- [ ] Latency class drives streaming + provider selection
- [ ] Model transitions inside a run are evented
- [ ] cost_per_accepted_outcome in /metrics

## Contract change
SETTINGS.md `models:` section — backport same PR.
