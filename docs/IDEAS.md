# IDEAS — post-MVP idea board

Parking lot for product ideas. **Nothing here is in MVP** — `MVP.md`
holds the v1 cutline; this board preserves ideas without growing scope.
When an idea graduates, it becomes a spec change (relevant `docs/*.md`
updated) + work package(s) in `docs/exec/`, tracked in `TRACKER.md`.

Entry format: one section per idea — problem, rough shape, what it
touches, open questions. Keep it cheap; detail comes at graduation.

Status legend: `parked` · `exploring` · `graduated` · `cut`

## I-001 — Observability / log ingestion — `parked`

**Idea:** feed application logs (sprint-runner's own logs, and later
logs from apps it manages) into the system as a first-class input
source. The conductor can then mine them: detect recurring errors,
cluster stack traces, spot regressions — and auto-draft tickets (bug
reports or user stories) for human triage.

**Why it fits:** the pipeline already turns unstructured input
(tickets, interviews) into specs. Logs are just another input channel —
a "log importer" next to the GitHub importer. Tickets drafted from logs
enter the normal triage → spec → implement flow, so human judgment
stays the gate.

**Rough shape:**
- **Log source adapter** — new importer type: tail a file / journald /
  docker logs / OTLP endpoint → normalized `log_events` table
- **Clustering** — group by signature (exception type + top frames);
  entity-linking + embeddings already exist for prior-art recall
- **Drafting** — a sentinel/transition that proposes tickets from
  clusters (title, repro context, first-seen/last-seen, frequency);
  human approves → becomes a real ticket
- **Feedback loop** — merged fix → watch for the signature to stop;
  re-open or escalate if it recurs
- **Dashboard** — log health widget on the metrics screen; per-signature
  timelines

**Touches:** importer contract (`ADAPTERS.md`), DB schema (new tables),
conductor (new trigger type), UI (new source + dashboard), prompts
(log→ticket drafting template).

**Open questions:**
- Self-observability only, or generic log source for arbitrary apps?
- Live tailing vs. batch ingest (batch is simpler; live enables
  alerting-style triggers)
- Does this stay local-only (files/journald) or do we want an OTLP
  receiver for real observability stacks?

## I-002 — Board templates — `parked`

**Idea:** preset zone layouts for boards — "release planning", "bug
bash", "customer complaints" — seeded zones + suggested item types.

**Why it fits:** boards are FEATURES.md §2; templates are cheap JSON
presets that teach the medium.

**Touches:** board creation flow, S-15/16.

## I-003 — Cluster-suggest pass — `parked`

**Idea:** periodic cheap run proposing "these 6 notes look like one
initiative" with a lasso preview before synthesis.

**Why it fits:** embeddings exist (sqlite-vec); board items are
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
