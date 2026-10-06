---
schema: 1
id: wp-120
title: Telemetry and incident intelligence — sanitized patterns to reviewed work
status: done
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

- [x] Connector spike documents the first supported backend and why; adapter contract remains backend-neutral
- [x] Secrets/credentials/PII/request bodies are redacted before any DB row, embedding, artifact, log, or model call
- [x] Variable values normalize without erasing exception class, error code, useful frames, service/resource, trace/span, version, or deployment identity
- [x] Repeated events update one versioned fingerprint/count; raw events are not copied into Veto or individually embedded
- [x] Structured backend query provides counts/time windows; vector retrieval is used only for similarity, never counts
- [x] Incident investigation emits ranked hypotheses, evidence, disconfirming evidence, next checks, and similar verified resolutions
- [x] Root cause and resolution remain unverified until a human/authoritative outcome records them
- [x] Draft-ticket creation requires an explicit human gate and then enters the normal pipeline; fixes/deployments/config changes retain existing controls
- [x] Retention removes derived signatures/investigations per policy without touching the source backend
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

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

- [x] Threat/privacy review covers connector credentials, redaction, retention, ACLs, and prompt injection
- [x] Incident golden set records cluster precision/recall and top-k cause recall
- [x] Production-change actions remain outside this work package
- [x] Raw telemetry ownership and deletion semantics are documented clearly

## Implementation notes (2026-10-08, landed on wp/120)

**Connector spike (AC 1):** the first supported backend is **OTLP**
(`telemetry_sources.kind: 'otlp'`). Rationale: OTLP is the
vendor-neutral wire protocol every observability backend already
ingests (traces/logs/metrics), so binding it covers Loki/Tempo/
collector deployments without per-backend clients; the adapter
contract stays backend-neutral — `POST /telemetry/ingest` accepts
decoded `TelemetryEvent[]`, so a Loki/journald/docker receiver only
has to produce events and register a source row of its own kind.

**Spec-gap resolutions (TRACKER D50):** incident statuses
`open|investigating|resolved|closed`; INC-NNNN via
`projects.next_incident_seq` (migration `0008_telemetry.sql` adds it
plus `incident_decisions` (append-only, trigger-enforced) and
`incident_ticket_proposals`); the §19 artifact is a doc_version on the
incident subject (D24); `resolve` requires caller-supplied
deployment/ticket/pr refs (an investigation alone is not evidence);
draft-ticket approve lands a capture-tray board item (retro-proposal
parity); retention = `pruneErrorSignatures`/`pruneIncidents` on derived
rows only.

**Threat/privacy review (DoD):** connector credentials — `config`
rejects literal values on secret-ish keys (`env:`/`ref:`/`$NAME` refs
only, fail-closed 400); redaction runs before any DB row/log/model
path and fails closed on unclassifiable events; ACL = workspace-scoped
source authorization (unknown/disabled source → refused);
prompt-injection in log text is quoted data, never executed (sanitize
is pure string rewriting; no model call exists in this package);
retention prunes derived signatures/incidents without touching the
source backend.

**Incident golden set (DoD):** the synthetic fixture suite
(`packages/conductor/test/wp120.test.ts`) is the v1 golden set —
cluster precision (variable values cluster; service-differentiated
near-duplicates do not), redaction coverage (tokens, emails, cards,
request bodies), dedupe aggregation, correlation ranking +
disconfirming disclosure, decide lifecycle, and gate coverage.
