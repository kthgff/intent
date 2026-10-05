# DELIVERY — Merge Center, Release Center & Improvement Center

Binding technical design for the post-review half of the lifecycle
(PRD §15.6). Ratifies the shared-chat's ten merge/release decisions
against the D29 DB-only architecture. Scope: local-first runtime with
tenancy-aware shapes (`workspace` stays the partition key; every new
table carries `workspace` + nullable `org` columns so a SaaS pivot
needs no schema rewrite — "design for both").

Vocabulary follows the adopted addendum naming (PRD §15.2): the UI says
*Solution* / *Requirements Specification (RS)* / *Solution Brief* /
*Verification Specification (VS)*; storage keeps `workspace` as the
internal key.

## 1. State model — the four-way separation

`approved ≠ merged ≠ deployed ≠ released`. Two orthogonal dimensions:

- **Development** (`tickets.status`, existing): …`approved → pr-open →
  ci-watch → merged`. Development Complete = verified merge only.
- **Delivery** (new, derived + materialized on `release_items`):
  `planned → released → deployed → exposed`. A feature is *available*
  only when `feature_exposure` says so — merge alone proves nothing.

`released` remains the terminal ticket status (D27): a ticket reaches
`released` when a release containing it is marked released; deployment
and exposure are release-level facts, not ticket statuses.

## 2. Merge Center (shepherd extension — Veto executes the merge)

The `ci-watch` tail becomes Merge Center. Deterministic merge
evaluation, no agent required:

- **Readiness checklist** (computed per `ticket_repos` row):
  approval bound to head SHA (stale-approval check), scope alignment
  (no unresolved deviations), AC evidence present, checks green,
  security findings resolved or risk-accepted, `depends_on` satisfied
  by `merged|verifying|released`, git-conflict check against target
  branch (`git merge-tree` on the worktree), branch-protection state
  from `gh pr view`.
- **Execution**: when checklist green → `gh pr merge --<strategy>`
  (`merge_strategy` setting already exists; `--auto` when the repo has
  a merge queue — queue enqueue counts as execution, confirmation
  arrives via shepherd poll). Confirm by reading back the merged SHA
  → `ticket_repos.merged_sha`, `status → merged`, `merged` event with
  `{sha, pr_url}`.
- **Ordering**: ready tickets merge FIFO by readiness time;
  `depends_on` re-evaluated on each merge event. Conflict →
  `merge_conflict` gate item + `rebase` run, never a silent force-push.
- **Post-merge**: append merge SHA/PR URL to the ticket's
  implementation note (doc_version), recalc feature evidence, notify
  release planner. Post-merge defects → `correction` ticket
  (`work_type: bug`, `origin: correction`, `parent:` the merged
  ticket) — original history is never rewritten; a material defect
  blocks any release containing the item.

## 3. Release entities (0001_init.sql amendment — pre-release)

All scoped `(workspace, …)`; `org TEXT` nullable reserved.

```
releases            release_id REL-NNNN (projects.next_release_seq),
                    title, status (draft|ready|approved|released|
                    closed|abandoned), target, created_by, created_at
release_items       release_id, item_kind feature|ticket, item_id,
                    partial_ac json (null = full), approved_by,
                    added_by, added_at, removed_at
release_manifests   release_id, version, digest (sha256 of items),
                    items json — item → [{repo, merged_sha}], created_at
                    (immutable; a "cut" freezes merged SHAs)
release_approvals   release_id, manifest_version, approver, decision,
                    rationale, created_at — approval binds to digest
release_notes       release_id, audience customer|stakeholder|
                    technical, doc_version ref, approved_by/at,
                    published_at
release_gate_results release_id, gate, result, evidence json, checked_at
deployments         deployment_id, release_id, environment, sha,
                    evidence json {type:'manual', by, note, url},
                    confirmed_by, confirmed_at  (MVP: manual only;
                    `evidence.type` reserves webhook|probe)
feature_exposure    feature_id, environment, state hidden|limited|
                    available, audience, evidence, updated_at
release_outcomes    release_id, kpi json {baseline,target,observed,
                    unit}, measured_at
```

Not separate tables: **correction tickets** are `tickets` rows
(`origin:'correction'`); **retrospectives** are `doc_versions` on the
release subject (`retro.md` doc kind); **release notes content** lives
in doc_versions (`notes-<audience>.md`), `release_notes` holds the
publication metadata.

## 4. Invariants (fail-closed)

1. `merged` set only from a source-control-confirmed merge SHA.
2. `released` requires an approved manifest whose items all carry
   `merged_sha`.
3. Approved manifests never mutate — a scope change cuts a new
   `release_manifests` version and resets pending approvals.
4. `deployments` rows require non-empty evidence; `feature_exposure`
   `available` requires a linked deployment.
5. Partial releases (`partial_ac` non-null) require `approved_by`.
6. AI stage output (release notes drafts, scope suggestions, risk
   narratives) is `ai-suggested` until a human approval event exists.
7. Correction tickets do not alter the merged ticket's history or
   its original AC verdicts; they carry their own ACs.

## 5. New stage + events

- Stage: `release-notes` (agent stage — drafts the three-audience
  notes from the frozen manifest; runs `doc-only`, no repo exec).
- Runner task kind: `merge` (deterministic — the checklist + `gh pr
  merge` + confirm; joins `verify`/`import` as agent-less tasks).
- Events: `merge_ready`, `merge_attempted`, `merge_conflict`,
  `release_created`, `release_items_changed`, `manifest_cut`,
  `release_approved`, `release_released`, `deployment_confirmed`,
  `feature_exposed`, `release_note_approved`, `retro_completed`,
  `correction_filed`.
- SSE mirrors the same names (API.md stream).

## 6. API surface (API.md amendment lands with wp-136)

```
GET/POST /api/v1/releases/:workspace
GET      /api/v1/releases/:workspace/:rel      (items+manifest+approvals+gates)
POST     /api/v1/releases/:workspace/:rel/items      {item_kind,item_id,partial_ac?}
POST     /api/v1/releases/:workspace/:rel/freeze     → cut manifest
POST     /api/v1/releases/:workspace/:rel/approve    {decision,rationale}
POST     /api/v1/releases/:workspace/:rel/deployments{env,sha,evidence}
POST     /api/v1/features/:workspace/:f/exposure     {env,state,evidence}
GET      /api/v1/merge-center/:workspace             (readiness per ticket)
POST     /api/v1/tickets/:workspace/:t/corrections   → correction ticket
POST     /api/v1/releases/:workspace/:rel/notes/:audience/approve
POST     /api/v1/releases/:workspace/:rel/retro      → retro run
```

## 7. Improvement Center

Post-release closure: when a release closes → AI retrospective run
(`retro` subject = release) comparing delivered behavior vs approved RS
+ KPI outcomes; produces draft board proposals (never commits scope).
Metrics rollup: idea→merge lead time, cost/feature, change failure
rate, deployment rework — per-goal (D33) and per-release.

## 8. UI

Two surfaces in `packages/ui`: **Merge Center** (readiness checklist
per ticket, merge order, conflicts) and **Release Center** (release
list, manifest diff vs approved scope, approvals, deployments,
exposure, notes editor, retro view). Delivery status column joins the
existing dev-status chips.
