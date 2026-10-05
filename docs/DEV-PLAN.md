# DEV-PLAN — Addendum program (PRD §14+§15)

Development plan for the post-addendum build. Companion docs:
`EXEC-PLAN.md` (agent dispatch mechanics), `TRACKER.md` (live rows),
`DELIVERY.md` (binding design for W17), `PRD.md` §14/§15 (ratified
scope + conflicts log). Ratified in planning session → TRACKER D43.

## 1. Program goal

Ship every locally-compatible capability from the addendum, led by the
delivery half of the lifecycle so Veto end-to-end proves:

> **idea board → discovery → RS baseline → design → tickets →
> implement → review → merge → release → deployment evidence →
> exposure → outcomes → retro → next ideas**

under the promise *Agents propose. Humans veto.* / *No Surprises at
Delivery* (`approved ≠ merged ≠ deployed ≠ released`).

Posture: local-first runtime; **design-for-both** schema shapes
(`workspace` + nullable `org` everywhere new) so the SaaS pivot
needs no rewrite. New vocabulary adopted: Solution / Requirements
Specification / Solution Brief / Verification Specification.

## 2. Sequencing rationale

The addendum splits into two halves with a hard contract boundary:

- **Upstream** (W18–W19): statements, boards, interview orchestrator,
  change control — everything that *produces* an approved baseline.
- **Downstream** (W17, W20–W22): merge/release/review/taxonomy/routing —
  everything that *verifies and delivers* it.

Delivery leads (user decision) because it completes the lifecycle's
weakest link and its entities (releases, manifests, deployments) are
referenced by upstream machinery (ChangeSet options "next release",
scope-radar commitment impact, feature acceptance → release assignment).

Contract-first rule holds at program scale: **wp-131 freezes every new
enum/schema/table/Store signature once**, so the six parallel lanes
below never invent divergent types. This is the wp-002/wp-090 pattern
applied to a bigger program — interface drift is the failure mode.

## 3. Milestones (demo-able exits)

| M | Wave | Ships | Exit demo |
| --- | --- | --- | --- |
| M0 | W16 | Green base + contracts v3 + rename | `pnpm test` green; `wp-094` tail closed; all new enums/tables exist; UI says Solution/RS |
| M1 | W17 | **Merge + Release + Improvement Center** | Ticket merges via checklist→`gh pr merge`→SHA-confirm; release draft→freeze→approve→manual deploy evidence→exposure→retro→board proposal (wp-138 E2E) |
| M2 | W18 | Change control | ChangeSet draft→analyze→approve→apply rebaselines docs, pauses/reconciles a pinned run; scope radar shows drift |
| M3 | W19 | Semantic discovery | Board notes → statements (provenance preserved) → slot-driven interview → source-linked RS draft → approve; import board reconciles before autonomy |
| M4 | W20 | Review & design depth | Finding lifecycle + commit-bound approvals + stale-delta view; mockup.json trees w/ visual ACs; security dimension blocks critical |
| M5 | W21 | Taxonomy + machinery | work-type×origin intake, DoR/DoD gates, assumption/debt/commitment registers, contract-first decomposition |
| M6 | W22 | Model governance | routing registry live on all call sites, latency classes, cost-per-accepted-outcome in /metrics, golden-set promotion gate |
| M7 | W23 | Close-out | discovery→tickets E2E green; specs reconciled; TRACKER all done/cut |

Reference pilot (from the shared chat, kept as the acceptance
scenario): *"add password reset to an existing app"* — connect repo →
board → interview → RS approve → mockup → TDD+contracts → two tickets
(one autonomous, one manual) → tests → review → merge → release →
deployment evidence → delivery report. M1 must demo steps merge→report;
M3 the discovery front.

## 4. Work packages (all in `docs/exec/`)

| M | wps | Scope |
| --- | --- | --- |
| M0 | wp-130, 131, 132 | regreen fold-in; contracts v3; vocabulary rename |
| M1 | wp-133–138 | merge exec; release core; deploy/exposure/notes/retro; delivery API; delivery UI; delivery E2E |
| M2 | wp-140–142 | changesets; baseline pinning + run reconcile; scope radar |
| M3 | wp-143–147, 139 | statement ledger; board v2; interview orchestrator; understanding panel; discovery UI; import reconcile |
| M4 | wp-148–150 | review findings lifecycle; design artifacts/mockups; security dimension |
| M5 | wp-151–154 | ticket taxonomy; feature workspace; DoR/DoD/registers/commitments; decomposition engine |
| M6 | wp-155–157 | model routing registry; eval lab; test-env requests |
| M7 | wp-158–159 | discovery E2E; docs reconciliation + green gate |

## 5. Execution model (mechanics in EXEC-PLAN §W16+)

- **8 agent slots**, sequential spine wp-130→wp-131, then six parallel
  lanes + close-out. Conductor package is the chokepoint — its file map
  is serialized per-lane; `packages/api` `server.ts` edits rebase,
  never stack; UI lane codes against API contracts with mocks.
- Every wp: branch `wp/<id>` off main → green (`typecheck/test/lint`)
  → PR → TRACKER row updated by its agent only.
- Contract changes outside wp-131 = flagged `## Contract change` block.
- Spec gaps resolve + backport into `docs/*.md` in the same PR.
- Deferred-scope guardrail: nothing from PRD §15.11's deferred list
  ships (wp-159 audits for leakage).
- wp-110/111/112/120 (D37) interleave at W19/W20 boundaries — wp-110
  also consumes wp-131 contracts.

## 6. Risks & review gates

| Risk | Mitigation |
| --- | --- |
| wp-131 contract churn ripples all lanes | Freeze review before fan-out; follow-up contract edits are PRs, not lane edits |
| Conductor serialization starves lanes 2–4 | File-map subdir ownership (merge/ changes/ semantics/ interview/ review/ decompose are disjoint dirs) |
| Naming rename collides with in-flight lanes | wp-132 runs early inside W16; UI lane absorbs it |
| Scope creep inside the wave itself | wp-159 gate + per-wp AC review; addendum deferreds stay in follow-ups |
| wp-130 regreen drags | It gates wp-131 — if blocked >1 session, escalate rather than fan out on a red base |

Weekly review (or per-milestone): demo the M-exit on a fixture repo;
TRACKER rows are the agenda.
