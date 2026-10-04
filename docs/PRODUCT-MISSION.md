# Product mission — sprint-runner

**Date:** 2026-10-04 · **Reviewer:** PM diligence pass (docs + code, claims vs
reality) · **Scope:** `docs/*.md`, all 12 `packages/*` (typecheck clean, ~300
tests green incl. a real detached-process E2E pipeline run), prompt templates,
fixtures, git history.

Method note: docs are claims, code is evidence. Where they disagree, code wins
and the disagreement is called out.

---

## The one-liner

**Mission statement (docs):** *"Code is cheap now; judgment isn't."*
sprint-runner moves engineering attention upstream — it helps a human forge a
rough ticket into a rigorous spec (PRD → TDD → test plan, each human-gated),
lets pluggable agent backends implement it, then independently verifies the
output and produces a replayable audit ledger per ticket (PRD.md:12-16, 25-33).

**The honest version:** this is **not** "AI writes code." The repo contains
zero codegen — implementation is entirely delegated to external CLIs (`devin
-p`, aider+OpenRouter) through an adapter contract
(`packages/adapters/src/devin/adapter.ts:1-8`, `aider/`). What the repo's
~34k lines actually are: a **governance and attention-routing layer** — a
state machine (`conductor/transitions/table.ts`), spec-quality machinery
(`lints/spec-lint.ts`, `coverage.ts`, `doc-lint.ts`), a human-gate queue
(`gate_items`), independent review and ground-truth verification
(`conductor/review/`, `envops/verify.ts`), and a git-native audit ledger
(`events.jsonl` + generated `LOG.md`). The weight sits overwhelmingly on the
spec/verification side: the heaviest package is the conductor (8,796 LOC —
gate logic, transitions, reconcile), then the UI (8,287), adapters (2,112),
lints (949). "Humans write specs and AI fills in the rest" is accurate; more
precisely, **AI drafts the specs too — humans approve them, and the machine
proves the code matched them.**

The repo's own review doc agrees and says the framing should be "audit and
quality control for agent-authored code," not "batch ticket runner"
(REVIEW.md:11-20, 383-394).

---

## Who it's for

**Primary user (evidence-based): a solo senior engineer or tech lead** who is
already driving agent CLIs on real tickets and has been burned by a
confidently-wrong agent PR (this is REVIEW.md:291-297's stated beachhead, and
the code backs it):

- **Single actor model.** `actor:` is one config string
  (`packages/core/src/config.ts:121`); a `presence` table exists but there's
  no auth model beyond one bearer token per install (API.md:10-25).
- **Solo storage.** SQLite only; Postgres deferred to M6 (TRACKER.md D6,
  DB-SCHEMA.md:1-5).
- **Team = "shared queue," designed-for but thin.** Multiple installs may
  point at the same tickets repo; stage-run leases fence via git-ref CAS
  (`conductor/loop/lease.ts:54-55`), and gate claiming exists via a DB
  `claims` table (`migrations/0001_init.sql:25`,
  `api/server.ts:1422-1466`). But the `refs/locks/claims/` CAS helper for
  human gates exists in gitops (`ops.ts:191`) and is **never called** — so
  under the zero-infra story (no shared DB), two humans can still collide on
  the same wizard. Effectively: multi-human is a roadmap item wearing shipped
  clothes.
- **Workspace = a tickets repo**, not an org (`tickets_repos` config,
  DB-SCHEMA.md:14-17) — the mental model is "one person shepherding N repos'
  tickets," with team features (Postgres, daemon, claims, SSO) deferred.

**Context of use:** local-first by design — worktrees, agent CLIs, detached
processes all assume the user's metal (PRD.md:35-45); a web UI served on
localhost wrapped (eventually) in a thin desktop shell.

---

## The daily loop

WF-12 (UI-INVENTORY.md:94-100) is the imagined Tuesday, and the machinery for
it is real:

1. **Overnight:** the conductor tick loop (reconcile → claim → launch,
   `conductor/loop/conductor.ts:57-74`) pulls the tickets repo, sweeps live
   runs, and auto-advances every non-gate transition — shepherd polls open
   PRs in the same tick (`conductor.ts:82-107`). Agent work happens
   unattended.
2. **Morning:** the human opens the app to a needs-attention surface —
   `gate_items` ranked into an inbox (`api/server.ts:469-475`, `rankInbox`
   at :155-162). Today the home is the Inbox screen; the Board default is
   designed but unbuilt (wp-081, todo).
3. **Clearing the queue** = the actual job: answer wizard questions
   (`POST /tickets/…/answers`, server.ts:613-686), approve PRD/TDD/test docs
   (`/docs/:name/approve`), hit the **spend checkpoint** "go implement"
   (`actions.go_implement`, server.ts:910-913 — deliberately the only
   non-gate transition that waits for a human, CONDUCTOR.md:82-85), review
   findings on the code-review page, approve → open PR, merge when green.
4. **Everything else is routed to the queue too:** failures, escalations,
   doc-repair items, split plans — the inbox is the failure surface as well
   as the approval surface.

A full-mode ticket touches the human up to ~7 times (needs-info, design-qa,
3 doc reviews, spend checkpoint, changes-requested, approve/merge);
`plan-package` compresses doc review to one gate and `minimal` to ~3
(`conductor/gates/index.ts:57-79`). This is **intentional, not accidental** —
"your judgment is still the gate" is the explicit thesis, and gate modes are
the tunable attention budget. The "inbox" organizing principle holds up in
code: every gate surfaces as a `gate_items` row with a notification, and the
E2E test drives a ticket `imported → pr-open` purely by clearing gates
(`conductor/test/e2e/pipeline.test.ts:165-296`).

---

## The wedge

Three mechanisms are genuinely differentiating vs. Devin/aider/Copilot alone.
The rest of the pipeline (ticket → branch → PR) is commodity.

1. **Spec quality as a measurable, enforced artifact — before tokens are
   spent.** A zero-token mechanical linter scores every imported ticket
   (`lints/spec-lint.ts` — vague-verb regexes, placeholder detection,
   verifiable-AC checks → `spec_score` stored per ticket,
   `migrations/0001_init.sql:91`, emitted as a `spec_scored` event and
   injected into triage as `{{SPEC_LINT}}`). Downstream, deviations from the
   approved TDD must be logged by the implementing agent
   (`templates/implement.md:28-31`, `DEVIATIONS.md` + TDD addenda, with a
   `DEVIATION_REASON_KINDS` taxonomy in `enums.ts:415`). Nobody else sells
   "your spec was wrong, here is the measured rate." **Caveat: deviation
   rate is captured but never computed into a metric** — see Claims vs
   reality.
2. **Independent verification, not agent self-report.** The runner re-runs
   the repo-card test command itself and emits `test-report.json`
   (`envops/verify.ts`, detached so a slow suite never stalls the tick);
   planned cases are greppable via a `case:<id>` convention
   (`implement.md:34-35`). Code review is four specialist passes
   (correctness/security/spec-compliance/test-gap,
   `templates/review-passes.md`) merged by the **runner** with
   runner-computed fingerprints for cross-round dedupe
   (`lints/fingerprint.ts`, `conductor/review/merge.ts`) — plus a
   severity-gated auto-fix loop with a self-dismissal cap so the corrected
   agent can't overrule the corrector wholesale (SETTINGS `fix_dismissal_cap`).
   "Check the agent's work with a different model, mechanically where
   possible" is the real differentiator.
3. **The attention queue as product primitive.** `gate_items` + claims +
   notifications + SSE is a routing system for human judgment: the pipeline
   is engineered to never need a human *except* at surfaced gates, and to
   park everything else. Devin et al. give you a chat per task; this gives
   you an inbox across all in-flight work with snooze/claim/ranking (snooze
   itself is not yet built — `gate_items.snoozed_until` doesn't exist,
   TRACKER follow-ups).

**Commodity (call it what it is):** prompt rendering + spawning agent CLIs,
worktree management, `gh pr create`, CI polling — all real, all working, all
being absorbed into the vendors' native features (REVIEW.md:202-209).

---

## What it is NOT

Explicit non-goals, cited:

- **Not a code generator.** Adapters spawn external agents; the product
  never writes a line of implementation (`adapters/` interface contract,
  PRD.md:129-147).
- **Not cloud SaaS.** "CANNOT be cloud-hosted — worktrees, agent CLIs… are
  local-machine operations"; multi-tenant deferred (PRD.md:40-44). No cloud
  code exists anywhere.
- **Not fire-and-forget autonomy.** Human approve is mandatory before PR
  open; never auto-merges in v1 (PRD.md:538-539, 590-595).
- **Not a general tracker.** Jira/Linear importers deferred; only GitHub
  issues importer shipped (MVP.md:56; `conductor/import/github.ts`; D17).
  `escalated` = an internal queue, no tracker write-back (PRD.md:796-798).
- **Not multi-tenant team software yet.** Roles/assignment deferred
  (MVP.md:61); shared-queue is effectively single-human until gate claims
  work cross-install.
- **Not voice-first, not a desktop app yet.** Voice = webview speech API
  only, shell-dependent (PRD.md:486-489; no implementation found beyond
  demo). No Tauri/Electron shell exists at all.
- **Not an observability platform.** Log ingestion is a single parked idea
  (IDEAS.md I-001 — the only entry, correctly parked).

---

## Claims vs reality

| Doc claim | Code evidence | Verdict |
| --- | --- | --- |
| Conductor serves the full web UI on localhost; "one surface" (CONDUCTOR.md:26-30, API.md:4-8) | `GET /` returns a placeholder `<h1>` (api/server.ts:435-438); the 14-screen Vite SPA is a separate app, reachable via `vite dev`/`?demo=1` only | **Not wired.** Screens are built; the product can't serve them. |
| `sprint-runner daemon` headless mode, `init`/`tick`/`status` (PRD.md:42-43) | All four commands print "not yet implemented" (`cli/src/bin.ts:26-31`) | **Stub.** There is no launchable entrypoint; engine is embeddable but nothing embeds it. |
| Pipeline works end-to-end (all 15+ stages, gates, review, shepherd) | Real E2E test: detached mock-agent processes, fixture repos, `imported → pr-open` across every gate, all 3 gate modes, doc-repair, retry ladder, kill-on-timeout (`pipeline.test.ts`, 6 tests pass) | **True — with mock agents.** Never run against a real LLM backend; devin export format unverified (D16 open). |
| Prompt set "locked/shipped" (PRD §12.27) | All 20 stage templates exist in `core/templates/` (incl. prd, survey, escalate, ci-fix — REVIEW.md's missing-prompts complaint was fixed) | **Fixed since the review.** |
| Deviation rate = headline metric (PRD.md:120-123) | `DEVIATION_REASON_KINDS` enum + DEVIATIONS.md contract exist; **no computation anywhere** — `/metrics` returns raw aggregates only (server.ts:1363-1416) | **Schema-only.** The flagship number isn't produced. |
| `human_minutes` ROI metric, gate-dwell capture (PRD.md:100-103; DB-SCHEMA.md:123 "dwell = human_minutes source") | Schema field exists; `surfaced_at`/`cleared_at` on gate_items make dwell computable — but every `appendEvent` writes `null` (reconcile:204,348,424; launch:366; claim:214…) and `clearGate` (server.ts:334-363) computes nothing | **Plumbed, never populated.** The metric that proves the thesis reads 0 forever. |
| Board home = default (D21, UI-INVENTORY.md:5-11) | wp-081 status `todo`; no `/board` endpoint exists (API.md:44 documents it); `/` route mounts `Inbox` (App.tsx:88) | **Designed, unbuilt.** Only remaining wp. |
| Git-ref CAS covers stage runs AND human-gate claims (PRD.md:346-350, item 36) | `refs/locks/<subject>-<stage>` used (lease.ts:54); `refs/locks/claims/` helper exists (ops.ts:191) but is never called — gate claims are DB-only (server.ts:1445) | **Partially true.** Multi-install gate collision still open. |
| Jira/Linear importers "contract ready" (MVP.md:56) | Only deterministic GitHub importer (`import/github.ts` + D17); CSV endpoint missing (SCREEN-MATRIX S-03); Jira field-mapping flagged unspec'd (PRD.md:807-809) | **Contract only.** GitHub works. |
| Live run monitor: transcript stream + token counters (UI-INVENTORY WF-05) | `run_output` SSE event has no producer (TRACKER.md:81); `usage_partial` is wired; screen exists | **Partial.** Usage streams, transcript doesn't. |
| S-08 code review centerpiece: review.json, diff, test-report (PRD §7) | `GET /tickets/<ref>/review` missing — UI fails soft from event payloads (TRACKER.md:80, D19) | **Thin.** Findings verdicts + approve work; the evidence surface is incomplete. |
| Spend/token caps + kill-switch (PRD.md:571-574) | `budgets:` in SETTINGS, `caps-action.ts`, `killedForCap` sweep; shepherd cycle cap, dismissal cap, `concurrency.implement: 1` default (config.ts:135) | **Real.** REVIEW.md's "no cost budget" complaint fixed. |
| Desktop shell (Tauri preferred) for presence (PRD.md:36-38) | Nothing — no shell code, no packaging | **Not started.** |
| "Agent proposes, human disposes" (mandatory recommendations, accept-all) | Enforced in prompt contracts (`triage.md:33-37` — a question without a recommendation "means you didn't finish"), wizard UI, `recommended` markers | **Real, and load-bearing.** |
| Layered spec package for weak models (PRD.md:283-286) | `implement.md:8-12` injects TDD+test+PRD+cards unconditionally; PRD §13 honestly lists it as open | **Honestly deferred.** |
| `sprints/2026-10` sample tickets | Still v0 format (`repo:` singular, `status: todo`) — README flags them as the v0 prototype | **Doc litter, disclosed.** |
| Inbox ranking "human-anxiety-first" (D21) | Code comment still says "blocking-first" and sorts `blocked_agent` desc (server.ts:154-158) — a reasonable approximation, wrong name | **Minor drift.** |

**TRACKER's cut/deferred history as priority signal:** 21 work packages
landed in ~1 day (git log, 2026-10-03) via the multi-agent build plan the
product itself dogfoods. What got done: engine, E2E, review pipeline,
shepherd, importers, KB/embeddings, all 14 screens. What got deferred: the
Board (the product's front door), the CLI entrypoint, daemon/Postgres,
packaging, and every follow-up in TRACKER.md:76-88. Reading it plainly:
**breadth won over launchability** — the system proves the loop works
(against mock agents) before it proves anyone can start it.

---

## Mission risks

- **Product risk — the bet itself, unproven and unmeasurable so far.** The
  thesis is "trust, not generation, is the bottleneck" (PRD.md:25). If
  frontier coding agents become trustworthy raw — or their vendors ship
  native spec-gates and review — this is scaffolding the market removes
  (REVIEW.md:184-192, 202-209, said bluntly). Worse, the product cannot yet
  *prove* its own thesis: `human_minutes` and `deviation rate` — the two
  metrics that would demonstrate "attention saved, specs improved" — are
  unimplemented (see table). The strongest counter-evidence in its favor:
  the entire REVIEW.md critique was systematically fixed in one build pass,
  suggesting iteration speed is the real asset.
- **Positioning risk — it reads as a feature of the agents it orchestrates.**
  "Batch tickets → branches → PRs" is now a vendor-native checkbox in
  Devin/Claude Code/Codex. The name says "runner"; the moat says "governance"
  (REVIEW.md:217-221; PRD.md:805-806 admits it). If this ships positioned as
  a better ticket-batcher it will be evaluated against free features and
  lose. The durable layer — spec gates, independent-model review,
  ground-truth verification, the audit ledger — is what's defensible, and
  it's also what the vendors are least likely to build honestly (a reviewer
  with no shared blind spots can't be the implementer).
- **Adoption risk — ceremony and setup weight.** `full` mode is ~7 human
  touchpoints per ticket; onboarding requires a tickets repo, per-repo cards,
  PATH deps (git, gitleaks, gh, a backend CLI), worktrees, layered YAML
  (WF-01 is a 7-step flow). `minimal` compresses to ~3 touches but is not
  the default story the docs tell. And today the tool can't even be
  launched — no CLI, no served UI, no shell. The first-run experience is
  currently `pnpm dev` plus demo fixtures.
- **Execution risk (smaller):** never run against a real agent — devin's
  export schema is unverified (D16 open), aider flag set unverified; the
  mock adapter is load-bearing and honest about it. A single real-ticket
  pilot will surface a month of latent issues.

---

## Open questions

Things the docs can't answer — ask the founder:

1. **Launch story:** is there a plan and a wp for the entrypoint (CLI →
   conductor + serve the UI dist), or is the Vite app meant to ship
   separately? API.md promises one surface; code delivers two disconnected
   halves.
2. **Business model:** BYOK-only OSS engine with a paid team tier
   (REVIEW.md:340-348 proposes $20–40/seat — is that the intent)? Nothing in
   code or docs commits to a pricing shape, and "potential product/OSS"
   (PRD.md:151-152) leaves it deliberately open.
3. **Deviation-rate formula:** per-ticket addenda rows ÷ what — merges?
   file-plan rows? There's no spec for the flagship metric's denominator.
4. **`human_minutes`:** gate-dwell is computable today (surfaced_at →
   cleared_at) — is the honest-idle-caveat version acceptable as v1, or is
   real attention tracking required?
5. **Wedge user vs buyer:** solo senior IC beachhead (what the build
   optimizes for — SQLite, single actor) or team lead/compliance buyer
   (REVIEW's recommendation)? The roadmap serves both; the sequencing
   doesn't say which.
6. **Shared queue honesty:** ship "multiple installs, one tickets repo" in
   v1 docs, or scope it to single-human until gate claims use the git-ref
   CAS that exists but is unwired?
7. **Pilot:** the ≥3-real-ticket pilot (MVP.md:66-71) is "explicitly NOT a
   build gate" — but with a mock-only track record, should it be?

---

## Recommendation

- **Sharpen — reposition and rename before any external exposure.** The
  defensible product is *governance for agent-authored code*: spec-gating,
  independent-model review, ground-truth verification, audit ledger. Rename
  away from "sprint-runner" (both PRD §13 and REVIEW flag it); lead with the
  review surface and the ledger, not the pipeline. Concretely: finish the
  Board (the front door), wire the CLI entrypoint, and have the conductor
  serve the UI — the product is currently unlaunchable, which makes every
  other question premature.
- **Cut — narrow the advertised surface to what code proves.** Stop
  advertising: shared-queue multi-human use (until gate claims hit git-ref
  CAS), daemon mode, Jira/Linear, voice, "the full product" MVP framing.
  Keep them in IDEAS/deferred honestly. The MVP doc claims "MVP = the
  complete product" (MVP.md:12-13) — the honest cutline is "a working
  engine, a UI you can demo, a ledger that already works."
- **Double-down — make the two headline metrics real, then run the pilot.**
  Implement `human_minutes` as gate-dwell (the data is already there — one
  subtraction in `clearGate` plus an event field) and compute deviation rate
  in `/metrics`. These two numbers ARE the pitch ("did it save attention?
  did the spec hold?"), they're schema-ready but vapor today, and without
  them the metrics dashboard is an aggregate counter page. Then run ≥3 real
  tickets through a real backend — the mock-adapter green checkmark proves
  the state machine, not the product.
