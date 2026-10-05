# S-17 — Feature Focus

Design doc companion to `UI-INVENTORY.md` §2 and `FEATURES.md` §1.
Status: inventory-complete, coded mockup pending 2026-10-04.

Purpose: govern one delivery unit between an Initiative and its implementation
Tickets. Feature Focus reuses the S-05 operational-hub structure: one immediate
Next action, a wide workbench, and a narrow Status/What's-left rail. It does not
use the superseded horizontal stepper or a permanent AI column.

## Layout

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ← IN-7   FE-3 — Saved payment methods        [Spec · test-review]     │
│          myApp · Q1 goals · P1 · owner KG               [Ledger][⋯]   │
│ ┌──────────────────────────────────────────────┐ ┌───────────────────┐│
│ │ NEXT ACTION — waiting on you · test review  │ │ STATUS            ││
│ │ test.md v2 · 7 ACs · 14 cases · 2 unmapped │ │ Test planning     ││
│ │ [Review plan] [Approve]                     │ │ Waiting on you    ││
│ ├──────────────────────────────────────────────┤ ├───────────────────┤│
│ │[Overview][Documentation][Tickets][Activity] │ │ WHAT'S LEFT       ││
│ │[Runs]                                       │ │ ✓ Feature defined ││
│ │                                              │ │ ● Test plan       ││
│ │ AC slice, coverage, or selected work surface│ │ ○ Tickets         ││
│ │                                              │ │ ○ Code review     ││
│ │                                              │ │ ○ Released        ││
│ └──────────────────────────────────────────────┘ ├───────────────────┤│
│                                                  │ FAMILY / KEY FACTS││
│                                                  └───────────────────┘│
└───────────────────────────────────────────────────────────────────────┘
```

## Page anatomy

1. **Header** — breadcrumb to Initiative, Project and originating Board; FE id,
   title, status badge, priority, owner, dependency/blocker chips, Ledger, and
   actions for Re-plan, Move/re-parent, and Cancel.
2. **Next action** — current document/split/verify gate, active run, failure,
   blocked dependency, or terminal outcome. The current action is completed
   inline or opens the full relevant workbench tab.
3. **Workbench tabs:**
   - **Overview** — `feature.md`, inherited Initiative context, AC slice,
     coverage summary, grounded-in-items link, cost/lead-time/progress.
   - **Documentation** — immutable `feature.md` + `test.md` versions, history,
     MR-style diffs, S-06 reviewer, trust-inheritance delta, contextual AI.
   - **Tickets** — child-ticket rollup: id/title/status/priority/owner/run,
     progress by released count, gates, cost; attach existing, create, or run
     Feature Decompose.
   - **Activity** — Feature plus descendant event timeline.
   - **Runs** — decompose/test-plan/re-plan/retro/verify runs.
   - Conditional **Failure**, **Split plan**, or **Verify** spotlight when the
     state requires it.
4. **Status rail** — current phase/owner of next move; vertical roadmap:
   `Defined → Test approved → Tickets → Code review → Released`; family links
   to parent Initiative and sibling Features; key facts beneath.

## AC, coverage, and provenance

- Every Feature owns the assigned slice of Initiative acceptance criteria.
- Each AC shows test case ids, pass/attest state, and board-item provenance.
- Unmapped AC/test rows are explicit lint failures, not muted warnings.
- `grounded in N items` opens S-18 Provenance filtered to this Feature's ACs.

## Actions

- **Feature Decompose** proposes implementation Tickets, then S-06 reviews the
  split plan before mechanical materialization.
- **Re-plan** runs decomposition against unmet ACs; terminal children are
  locked and S-06 renders the proposed v2 child diff.
- **Move/re-parent** changes Initiative with impact/provenance preview and emits
  `reparented`.
- **Cancel** requires explicit choices for open children and related consumed
  items; no silent cascade.
- **Verify/release** rolls descendant Ticket state up honestly. A Feature is
  released only when all required descendants are released or explicitly
  dispositioned.
- AI appears only inside the selected Feature/Test document or a selected
  review object. Proposed changes require human approval and a new version.

## Data

| Surface | Source |
| --- | --- |
| Header/status/roadmap | Feature projection + derived phase/rollup |
| Next action | open Feature gate, active run, failure, dependency, or terminal outcome |
| Documentation | immutable `doc_versions` for `subject_ref: FE-*` |
| AC/provenance | Initiative provenance + Feature AC assignment |
| Tickets | Ticket projections where `feature_id = FE-*` |
| Family | parent Initiative + sibling Features |
| Activity/Runs | events and runs scoped to Feature + optional descendants |

## Required states

No tickets yet · decompose running · split plan ready · test draft/review/
approved · tickets flowing · dependency blocked · implementation/review in
progress · failure · verifying · verify_failed · released · cancelled/partial.
At narrow widths the status/family rail stacks after the workbench.
