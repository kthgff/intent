# IDEAS — post-MVP idea board

Parking lot for product ideas. **Nothing here is in MVP** — `MVP.md`
holds the v1 cutline; this board preserves ideas without growing scope.
When an idea graduates, it becomes a spec change (relevant `docs/*.md`
updated) + work package(s) in `docs/exec/`, tracked in `TRACKER.md`.

Entry format: one section per idea — problem, rough shape, what it
touches, open questions. Keep it cheap; detail comes at graduation.

Status legend: `parked` · `exploring` · `graduated` · `cut`

## I-001 — Observability / incident intelligence — `graduated`

Graduated into PRD D37 / `INTELLIGENCE.md` Phase C on 2026-10-04. It
remains post-v1 in delivery order; `graduated` means the product and technical
contracts are accepted, not that implementation is scheduled before the
foundation.

**Idea:** connect application logs, traces, metrics, deployments, and resolved
incidents to the shared evidence plane. Detect recurring errors, correlate them
with code/change history, retrieve similar validated resolutions, and propose
evidence-backed bug tickets for human triage.

**Why it fits:** the pipeline already turns unstructured input
(tickets, interviews) into specs. Logs are just another input channel —
a "log importer" next to the GitHub importer. Tickets drafted from logs
enter the normal triage → spec → implement flow, so human judgment
stays the gate.

**Rough shape:**
- **Telemetry source adapter** — OTLP first; Loki/OpenSearch/file/journald/
  docker later. Raw high-volume data and count queries remain in the source
  backend; Veto stores opaque locators, not a duplicate log warehouse.
- **Safety boundary** — authorize + redact secrets/PII/request bodies before
  persistence, embedding, artifacts, or model access.
- **Clustering** — normalize carefully, fingerprint, deduplicate, and embed
  sanitized unique patterns/summaries rather than every event.
- **Investigation** — correlate error → trace → service/symbol → commit/PR →
  ticket/requirement → deployment → similar incident; return ranked hypotheses,
  disconfirming evidence, and next checks.
- **Drafting** — propose tickets with time window, frequency, evidence, affected
  code, and test plan; human approval creates real work.
- **Learning loop** — a resolution becomes reusable only after a human or
  authoritative system verifies the outcome; recurrence suggests follow-up but
  does not silently reopen or deploy anything.

**Touches:** `INTELLIGENCE.md`, evidence-source contract (`ADAPTERS.md`),
`DB-SCHEMA.md` telemetry/signature/incident rows, `SCHEMAS.md` §19,
conductor workers, API, source administration, incident UI, metrics, and
investigation/ticket-draft prompts.

**Open questions:**
- Which observability backend is the first supported read/query integration?
- Pull/query connector or local OTLP receiver first? Batch/query is simpler;
  live ingest enables earlier regression detection.
- What default redaction rules and retention bounds are defensible across
  languages and frameworks?
- Which authoritative deployment/resolution sources can verify correlations
  without asking a human to relabel everything?

## I-002 — Board templates — `parked`

**Idea:** preset zone layouts for boards — "release planning", "bug
bash", "customer complaints" — seeded zones + suggested item types.

**Why it fits:** boards are FEATURES.md §2; templates are cheap JSON
presets that teach the medium.

**Touches:** board creation flow, S-15/16.

## I-003 — Cluster-suggest pass — `parked`

**Idea:** periodic cheap run proposing "these 6 notes look like one
initiative" with a lasso preview before synthesis.

**Why it fits:** embeddings exist (pgvector); board items are
embeddable objects. Off by default; earns trust.

**Touches:** embeddings, board API, prompt template.

## I-004 — Voice-first board capture — `parked`

**Idea:** mic button on the canvas → record → transcribe → typed
sticky. Thinking shouldn't require typing; wizard speech path exists.

**Touches:** board UI, voice adapter (webview speech API first).

## I-005 — Escalated → back-to-board — `parked`

**Idea:** `escalated` tickets can bounce to a board card ("return to
thinking space") instead of only the S-10 queue — some tickets are
failed *ideas*, not failed runs.

**Touches:** escalation flow, board API.

## Template

```markdown
## I-NNN — <name> — `parked`

**Idea:** <one paragraph>

**Why it fits:** <why this product, not a separate tool>

**Rough shape:** <bullets>

**Touches:** <which specs/packages>

**Open questions:** <bullets>
```
