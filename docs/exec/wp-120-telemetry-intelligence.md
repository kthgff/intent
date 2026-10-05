---
schema: 1
id: wp-120
title: Telemetry and incident intelligence — sanitized patterns to reviewed work
status: todo
priority: low
depth: deep
repos: []
wave: W15
depends_on: [wp-112]
---

## Description

Implement D37 Phase C from `INTELLIGENCE.md` §6. Start with one real
observability query connector selected by a spike (OTLP receiver vs Loki query
client). Enforce authorization and redaction before persistence/model access;
normalize, fingerprint, and deduplicate error patterns; keep raw events/count
queries in the source backend. Correlate sanitized signatures with traces,
services/code, deployments/commits, tickets/requirements, and verified prior
incidents. Emit §19 ranked hypotheses and human-approved draft-ticket proposals.

## File ownership

`packages/core/**`, `packages/store/**`, `packages/kb/**`,
`packages/conductor/**`, `packages/api/**`, `packages/ui/**`,
`packages/prompts/**`, new telemetry adapter package, connector-specific docs

## Acceptance criteria

- [ ] Connector spike documents the first supported backend and why; adapter contract remains backend-neutral
- [ ] Secrets/credentials/PII/request bodies are redacted before any DB row, embedding, artifact, log, or model call
- [ ] Variable values normalize without erasing exception class, error code, useful frames, service/resource, trace/span, version, or deployment identity
- [ ] Repeated events update one versioned fingerprint/count; raw events are not copied into Veto or individually embedded
- [ ] Structured backend query provides counts/time windows; vector retrieval is used only for similarity, never counts
- [ ] Incident investigation emits ranked hypotheses, evidence, disconfirming evidence, next checks, and similar verified resolutions
- [ ] Root cause and resolution remain unverified until a human/authoritative outcome records them
- [ ] Draft-ticket creation requires an explicit human gate and then enters the normal pipeline; fixes/deployments/config changes retain existing controls
- [ ] Retention removes derived signatures/investigations per policy without touching the source backend
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

## Test plan

- Synthetic fixtures with tokens, emails, IDs, request bodies, stack traces,
  trace IDs, deployment markers, and two deceptively similar failures; assert
  redaction and cluster precision.
- Two million-event-equivalent aggregate fixture with 300 patterns; assert
  300 pattern embeddings, not per-event writes.
- Correlation fixture with a deployment and prior incident plus contradictory
  metric; assert ranked hypothesis includes both supporting/disconfirming refs.
- ACL and prompt-injection fixtures in log text; assert no leakage or execution
  of embedded instructions.
- Ticket proposal flow; assert no ticket before human approval.

## Definition of Done

- [ ] Threat/privacy review covers connector credentials, redaction, retention, ACLs, and prompt injection
- [ ] Incident golden set records cluster precision/recall and top-k cause recall
- [ ] Production-change actions remain outside this work package
- [ ] Raw telemetry ownership and deletion semantics are documented clearly
