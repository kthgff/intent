# Veto screen matrix

Implementation contract for the high-fidelity UI pass. The product home pairs a
pipeline Board with a needs-attention Inbox: background agents move work
forward, while these screens make human gates fast, legible, and auditable.

The visual mockup runs inside the existing `packages/ui` application with the
same routes as production. Add `?demo=1` (or set `VITE_DEMO_MODE=1`) to use
deterministic local fixtures without API or SSE calls. Demo mode is always
labelled in the shell.

| Screen | Route used for capture | Primary user task | Required states / data | Shared UI | API / implementation gap |
| --- | --- | --- | --- | --- | --- |
| S-01 Home | `/?demo=1` | See every ticket by phase, then clear the highest-impact human gate | Board default; Backlog/Spec/Build/Review/Done; attention-first cards; Ops strip; WIP; empty state; Inbox tab ranked human-anxiety-first | App shell, board columns, ticket cards, gate rows, filters, chips | Needs `GET /board` with derived phase/attention/drop targets; snooze needs `gate_items.snoozed_until` |
| S-02 Settings | `/settings?demo=1` | Configure models, pipeline, products, security, and notifications | Saved state, risky-setting warning, capability status, products tab | Tabs, fields, status rows, save bar | Product editing needs a dedicated contract; backend capability discovery is read-only today |
| S-03 Create / import | `/new?demo=1` | Turn an idea or source issue into a governed ticket | Idea interview, GitHub import, CSV import, preview, duplicate warning | Segmented tabs, step list, drop zone, preview panel | Current API imports GitHub only; CSV endpoint is missing |
| S-04 Q&A wizard | `/tickets/team-a/SR-0142/wizard?demo=1` | Resolve agent questions quickly | Progress, rationale, recommended answer, other answer, accept-all, bail-outs | Progress bar, answer cards, keyboard hints | Existing answer endpoint supports the core flow; voice depends on webview support |
| S-05 Ticket focus | `/tickets/team-a/SR-0142?demo=1` | Know the next action, complete it, and understand everything left for one ticket | Inline Next action; Overview/Documentation/Activity/Runs plus conditional spotlight; narrow Status/What's-left rail; contextual AI only in editing flows | Ticket header, gate panel, workbench tabs, evidence lists, vertical roadmap | Chat-to-edit needs ticket-scoped interview/apply APIs; production data spans several endpoints |
| S-06 Doc reviewer | `/tickets/team-a/SR-0142/docs/prd.md?demo=1` | Review a generated spec and approve or request changes | Rendered PRD, diff, coverage matrix, anchored comments, version history | Document canvas, comment pins, review rail, decision bar | Document API has content/diff but anchored comment persistence is not first-class |
| S-07 Run monitor | `/runs/run-impl-142?demo=1` | Monitor and safely control an agent run | Live transcript, stage, usage/cost, health, artifacts, pause/kill | Metric strip, terminal, run timeline, control bar | `run_output` SSE has no producer, so true live log streaming is not wired |
| S-08 Code review | `/tickets/team-a/SR-0142/review?demo=1` | Validate generated code, triage findings, approve or send back | Review brief, diffstat, AC traceability, deviations, files, findings, tests, verdicts | Diff viewer, file tree, finding cards, test table, decision bar | Missing `GET /tickets/<ref>/review` for review.json, diff, and test report |
| S-09 PR panel | `/tickets/team-a/SR-0142/pr?demo=1` | Shepherd multi-repo pull requests through CI and merge | PRs per repo, checks, reviews, merge strategy, comments, revert | PR rows, check list, commit strip, decision bar | Core actions exist; richer review/check detail depends on `gh` projection freshness |
| S-10 Failures | `/queue?demo=1` | Recover failed, aborted, escalated, or repair work | Queue filters, failure reason, log excerpt, retry/edit/wont-do actions | Queue rows, severity marker, detail inspector | Repair is supported as a gate kind; snooze remains unavailable |
| S-11 Ledger | `/ledger?demo=1` | Audit immutable product decisions and machine activity | Global/ticket scope, event filters, hashes, actors, token and cost data | Event timeline, structured payload inspector, filters | API supports events; cross-project/entity pagination remains shallow |
| S-12 Metrics | `/metrics?demo=1` | See throughput, quality, cost, and human effort | KPI strip, tickets-to-PR funnel, spec trend, deviation rate, failure stages, cost | KPI cells, CSS charts, data table, range filters | API currently returns aggregates, not time-series or cohort breakdowns |
| S-13 Projects | `/workspaces?demo=1` | Switch, inspect, add, and sync projects (merged workspace+product — D26) | Health, scope, queue, open gates, board count, last sync, add-project flow | Project cards, health chips, sync controls | POST registration is in-memory only and is not persisted to config.yaml; project entity merge not implemented |
| S-14 Knowledge base | `/kb?demo=1` | Browse and correct product dossiers and gap reports | Product/repo tree, dossier sections, personas, gaps, entities, survey freshness | Three-rail browser, dossier table, inline confirmation, survey card | KB content is supported; entity confirmation and gap disposition need explicit write routes |
| S-15 Boards list | `/boards?demo=1` (proposed) | Pick or create an idea board for a project | Board cards: name, item counts, unprocessed count, last synthesis, filter summary, archive | Card grid (same anatomy as S-13), new-board form | `GET /boards` + `POST /boards` not implemented (FEATURES.md §7) |
| S-16 Board canvas | `/boards/<id>?demo=1` (proposed) | Capture ideas, synthesize into initiatives, track spawned work | Idea mode: typed items, zones, connectors, icebox, agent `source:` chips, open→consumed→shipped states; Delivery mode: S-01 pipeline kanban scoped by saved filter, full card actions | Canvas impl (tldraw SDK proposed), sticky palette, item inspector, shared kanban columns | `board_items`/`boards` tables, `board-synthesize` run, `provenance.json` — all unimplemented |
| S-17 Feature detail | `/features/<ref>?demo=1` (proposed) | Review a feature's spec slice and child ticket rollup | S-05 operational-hub anatomy: Next action, docs/tickets workbench, AC slice, initiative + board links, Status/What's-left rail | Reuses S-05 focus layout and contextual AI | `features` entity, `feature:` ticket field, `feature-decompose` run — all unimplemented |
| S-18 Initiative detail | `/initiatives/<ref>?demo=1` (proposed) | Manage the spec container: docs, feature tree, provenance, re-plan | S-05 operational-hub anatomy: Next action, prd/tdd workbench with trust delta, features rollup, provenance editor, Status/What's-left rail | Reuses S-05 focus layout; new two-pane provenance editor | `initiatives` entity, provenance editor, `initiative-decompose`/`replan` runs — all unimplemented |
| S-19 Capture + Tray | `/capture?demo=1` and `/tray?demo=1` (proposed) | Capture an idea/feedback instantly, then route or synthesize it later | Minimal mobile-safe capture; content/type/project/board-or-tray/related subject; tray search/filter/preview/bulk move; ingest failure; synthesize selection | Shared capture form/modal, item inspector, board picker, selection toolbar | `/capture`, tray listing/mutation, attachment ingest, optimistic conflict handling, and tray synthesis are unimplemented |

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
