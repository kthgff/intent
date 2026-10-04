# Intent screen matrix

Implementation contract for the high-fidelity UI pass. The product remains a
needs-attention inbox: background agents move work forward, while these screens
make human gates fast, legible, and auditable.

The visual mockup runs inside the existing `packages/ui` application with the
same routes as production. Add `?demo=1` (or set `VITE_DEMO_MODE=1`) to use
deterministic local fixtures without API or SSE calls. Demo mode is always
labelled in the shell.

| Screen | Route used for capture | Primary user task | Required states / data | Shared UI | API / implementation gap |
| --- | --- | --- | --- | --- | --- |
| S-01 Inbox | `/?demo=1` | Clear the highest-impact human gate | Blocking-first groups; questions, approvals, reviews, failures, escalations, repair; claim, snooze, score, age | App shell, filter bar, gate rows, chips, progress ring | Snooze needs `gate_items.snoozed_until` and inbox support |
| S-02 Settings | `/settings?demo=1` | Configure models, pipeline, products, security, and notifications | Saved state, risky-setting warning, capability status, products tab | Tabs, fields, status rows, save bar | Product editing needs a dedicated contract; backend capability discovery is read-only today |
| S-03 Create / import | `/new?demo=1` | Turn an idea or source issue into a governed ticket | Idea interview, GitHub import, CSV import, preview, duplicate warning | Segmented tabs, step list, drop zone, preview panel | Current API imports GitHub only; CSV endpoint is missing |
| S-04 Q&A wizard | `/tickets/team-a/SR-0142/wizard?demo=1` | Resolve agent questions quickly | Progress, rationale, recommended answer, other answer, accept-all, bail-outs | Progress bar, answer cards, keyboard hints | Existing answer endpoint supports the core flow; voice depends on webview support |
| S-05 Ticket detail | `/tickets/team-a/SR-0142?demo=1` | Understand ticket state and take the next gate action | Family rail, state path, repo status, documents, activity, cost, “Go” spend checkpoint | Ticket header, stage timeline, doc rows, activity feed, context rail | Production data spans several endpoints; demo composes a single operational brief |
| S-06 Doc reviewer | `/tickets/team-a/SR-0142/docs/prd.md?demo=1` | Review a generated spec and approve or request changes | Rendered PRD, diff, coverage matrix, anchored comments, version history | Document canvas, comment pins, review rail, decision bar | Document API has content/diff but anchored comment persistence is not first-class |
| S-07 Run monitor | `/runs/run-impl-142?demo=1` | Monitor and safely control an agent run | Live transcript, stage, usage/cost, health, artifacts, pause/kill | Metric strip, terminal, run timeline, control bar | `run_output` SSE has no producer, so true live log streaming is not wired |
| S-08 Code review | `/tickets/team-a/SR-0142/review?demo=1` | Validate generated code, triage findings, approve or send back | Review brief, diffstat, AC traceability, deviations, files, findings, tests, verdicts | Diff viewer, file tree, finding cards, test table, decision bar | Missing `GET /tickets/<ref>/review` for review.json, diff, and test report |
| S-09 PR panel | `/tickets/team-a/SR-0142/pr?demo=1` | Shepherd multi-repo pull requests through CI and merge | PRs per repo, checks, reviews, merge strategy, comments, revert | PR rows, check list, commit strip, decision bar | Core actions exist; richer review/check detail depends on `gh` projection freshness |
| S-10 Failures | `/queue?demo=1` | Recover failed, aborted, escalated, or repair work | Queue filters, failure reason, log excerpt, retry/edit/wont-do actions | Queue rows, severity marker, detail inspector | Repair is supported as a gate kind; snooze remains unavailable |
| S-11 Ledger | `/ledger?demo=1` | Audit immutable product decisions and machine activity | Global/ticket scope, event filters, hashes, actors, token and cost data | Event timeline, structured payload inspector, filters | API supports events; product-level cross-workspace pagination remains shallow |
| S-12 Metrics | `/metrics?demo=1` | See throughput, quality, cost, and human effort | KPI strip, tickets-to-PR funnel, spec trend, deviation rate, failure stages, cost | KPI cells, CSS charts, data table, range filters | API currently returns aggregates, not time-series or cohort breakdowns |
| S-13 Workspaces | `/workspaces?demo=1` | Switch, inspect, add, and sync ticket repositories | Health, branch, queue, open gates, last sync, add-workspace flow | Workspace cards, health chips, sync controls | POST registration is in-memory only and is not persisted to config.yaml |
| S-14 Knowledge base | `/kb?demo=1` | Browse and correct product dossiers and gap reports | Product/repo tree, dossier sections, personas, gaps, entities, survey freshness | Three-rail browser, dossier table, inline confirmation, survey card | KB content is supported; entity confirmation and gap disposition need explicit write routes |

## Shared system

- Persistent 228 px sidebar plus 48 px context bar; content density is tuned
  for a 1440×1024 operational desktop and collapses cleanly at 1024×768.
- Inter for UI and JetBrains Mono for identifiers, hashes, paths, logs, diffs,
  counters, and code.
- One compact chip vocabulary for state, severity, kind, source, and confidence;
  labels and icons always accompany color.
- Reused primitives: `PageHeader`, `SectionHeader`, `Badge`, `Button`,
  `Metric`, `ProgressRing`, `DataTable`, `EmptyState`, `DemoNotice`, and the
  shared shell/navigation.
- Demo fixtures use stable IDs, timestamps, copy, counts, and selected states so
  screenshot output is reproducible.

