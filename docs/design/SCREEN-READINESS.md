# Screen readiness tracker

Updated 2026-10-04 after the Board approval and Ticket Focus redesign.

This tracker separates **design readiness** from **production readiness**:

- **Good to build** — the product direction/layout has explicit approval.
- **Review ready** — a coded mockup and screen spec exist, but product sign-off
  is still needed.
- **Needs design work** — the information architecture or mockup is incomplete
  or stale against a later product decision.
- **Not production-ready** — a mockup may look complete while live data,
  persistence, or action contracts remain unfinished.

## Executive summary

| Bucket | Screens |
| --- | --- |
| **Good to build** | S-01 Board layout |
| **Review ready** | S-01 Inbox; S-02–S-12; S-14; S-05 Ticket Focus is the next sign-off |
| **Needs design update** | S-13 Project switcher |
| **Needs coded mockup** | S-15 Boards, S-16 Board canvas, S-17 Feature detail, S-18 Initiative detail, S-19 Capture + Tray |
| **Fully production-ready** | None yet; the coded visual prototype uses deterministic demo fixtures and the gaps below still apply |

## Detailed tracker

| ID | Screen | Visual/design status | Production work left | Readiness |
| --- | --- | --- | --- | --- |
| S-01a | Home — Board | User-approved layout; desktop, compact, and empty captures exist | `GET /board`; server-derived phase/attention/drop targets; snooze persistence; validated drag/drop | **Good to build** |
| S-01b | Home — Inbox | Spec plus desktop/compact captures exist; not yet explicitly approved | Snooze field/API; final project vocabulary pass; live claims and counts | **Review ready** |
| S-02 | Settings | Spec and coded capture exist | Persist project/product editing; complete capability discovery and validation states | **Review ready** |
| S-03 | Create / Import | Spec and coded capture exist | CSV import endpoint; Jira remains deferred; connect interview/import completion | **Review ready** |
| S-04 | Q&A wizard | Spec and coded capture exist | Final shared-gate integration; voice depends on host/webview capability | **Review ready** |
| S-05 | Ticket Focus | Redesigned coded captures exist for human-attention, active-development, documentation-edit, and compact states; awaiting user sign-off | Compose live ticket/gate/run/doc data; ticket-scoped contextual edit/apply API; complete embedded review/failure/split states | **Review ready — next decision** |
| S-06 | Document review | Spec and coded capture exist | Anchored comment persistence; version/diff integration; initiative/feature variants | **Review ready** |
| S-07 | Live run monitor | Spec and coded capture exist | Produce true live `run_output` SSE; wire pause/kill/handoff and artifact links | **Review ready** |
| S-08 | Code review | Spec plus desktop/compact captures exist | Add `GET /tickets/<ref>/review`; wire diff, findings, test report, comments, and dispositions | **Review ready** |
| S-09 | PR status panel | Spec and coded capture exist | Richer `gh` projection for checks/reviews/comments; verify multi-repo merge/revert states | **Review ready** |
| S-10 | Escalations & failures | Spec and coded capture exist | Wire recovery actions; add snooze; confirm repair/stalled-run variants | **Review ready** |
| S-11 | Ledger | Spec and coded capture exist | Improve cross-project pagination and artifact drill-down; wire replay/compare | **Review ready** |
| S-12 | Metrics | Spec and coded capture exist | Add time-series/cohort API data; select/vet chart implementation; validate empty/partial data | **Review ready** |
| S-13 | Project switcher | Existing capture still reflects the older workspace model | Redesign/copy pass for D26 project vocabulary; persist add/sync and show board/initiative/feature rollups | **Needs design update** |
| S-14 | Knowledge base | Spec plus desktop/compact captures exist | Entity confirmation and gap-disposition writes; connect gaps to board items; survey freshness/sync | **Review ready** |
| S-15 | Boards list | Draft text spec only; no route or capture | Produce coded mockup; define list/create/archive/filter APIs and states | **Needs coded mockup** |
| S-16 | Board canvas | Draft text spec only; no route or capture; canvas technology undecided | Prototype canvas interactions; choose/vet SDK; define autosave, upload/ingest, synthesis, tray, and delivery-view contracts | **Needs design + technical spike** |
| S-17 | Feature detail | Updated text spec follows the S-05 operational-hub pattern; no route or capture | Produce coded mockup; define feature projection, gates, docs, dependencies, re-plan/re-parent, and child-ticket APIs | **Needs coded mockup** |
| S-18 | Initiative detail | Draft spec already follows the new S-05 operational-hub pattern; no route or capture | Produce coded mockup; define initiative/feature/provenance projections and mutation APIs | **Needs coded mockup** |
| S-19 | Quick Capture + Project Tray | Page/functionality spec exists; no coded route or capture | Design mobile/desktop states; define capture/tray/attachment-ingest APIs and tray-scoped synthesis | **Needs coded mockup** |

## Recommended review order

1. **Approve S-05 Ticket Focus** — it establishes the operational-hub pattern
   reused by Feature and Initiative detail.
2. **Review the core execution loop** — S-04 Q&A → S-06 Document review → S-07
   Run monitor → S-08 Code review → S-09 PR status.
3. **Review recovery and evidence** — S-10 Failures, S-11 Ledger, S-12 Metrics,
   S-14 Knowledge base.
4. **Resolve D26 navigation/entity language** — S-02 and S-13, plus the shared
   shell's `workspace` → `project` copy.
5. **Design the new planning layer** — S-15 through S-19, beginning with the
   Board canvas technical spike.

## Current approved interaction model

- Home is the five-phase Board; Inbox remains a second tab.
- A card opens a full-page operational hub, not a drawer.
- Ticket Focus leads with the immediate **Next action**, completed inline.
- The right rail has one current status and a vertical **What's left** roadmap.
- AI is contextual to editing ticket documentation or review objects; it is not
  a permanent page column.
- The Board design remains unchanged by the Ticket Focus redesign.
