# Screen & Workflow Inventory — sprint-runner

Companion to `PRD.md`. Status: draft 2026-10-03.
Organizing principle: **the app is a needs-attention inbox.** Every gate
in the pipeline produces a "your move" item; the home screen surfaces
them all and every other screen exists to clear one item type.

**Delivery:** one web app, served by the conductor on localhost — the
desktop shell is a thin wrapper (Tauri preferred) for native presence;
daemon mode serves the identical surface to any browser. No second
frontend, no Electron-only assumptions inside the screens.

---

## 1. Workflow inventory

### WF-01 — First-run onboarding
Welcome → pick backend (devin CLI / aider+OpenRouter) → provide key(s) →
connect tickets repo → add code repos (name + path + repo card probe) →
pick `main_model` + `review_model` → pick `gates` mode → done.
Screens: S-01, S-02.

### WF-02 — Create or import tickets
Two entry points: **Interview mode** (type a rough idea → AI interview
through the wizard → well-formed ticket.md committed) OR **Import**
(source: github milestone / jira JQL / csv → auth → preview+edit table
→ import → commit). Both land at `imported` → spec lint → triage.
Screens: S-03 (Create/Import), S-04 (interview = same wizard).

### WF-03 — Triage a ticket (needs-info loop)
Inbox item "questions on ABC-123" → Q&A wizard (one at a time, options +
recommended + mic + skip=accept) → "accept all" or answer → commit →
re-triage → repeat or ready/escalated. Bail-outs: force-ready, wont-do.
Screens: S-04 (wizard), S-05 (ticket detail context).

### WF-04 — Review & approve a doc (×3: PRD, TDD, test plan)
Inbox item "PRD ready" → doc review page (rendered markdown, comment
threads on paragraphs, diff vs prior version, coverage matrix for
test.md) → leave feedback (→ agent revises, new version) or approve →
next stage. `plan-package` mode: all three docs in one page, one approve.
Screens: S-06.

### WF-05 — Monitor implementation
Ticket detail → live run monitor: transcript stream, current TDD step,
elapsed / live in+out token counter / cost (where computable), commit
feed — plus **kill** (abort, preserve worktree), **pause**, **hand off
to human**.
Screens: S-07, S-05.

### WF-06 — Review code & merge
Inbox "review ready" → code review page: header brief (diffstat, AC
traceability, spec compliance, TDD addenda, risk register, tech-debt,
highlights, commit story) → Changes tab (diff + inline comments) →
Issues tab (LLM threads, accept/dismiss, batch-fix) → test panel
(ground-truth results) → **approve → merge** (strategy from settings) or
**send back to fix**.
Screens: S-08.

### WF-07 — Shepherd a PR (post-approve)
PR panel: CI checks live, teammate comments → auto-fed to agent → new
commits → re-check → green → merge button → merged (status, SHA logged).
Failure: revert button → `reverted`.
Screens: S-09.

### WF-08 — Handle failure / blocked
Inbox "ABC-123 failed" → failure detail (stage, reason, log tail, env
vs agent classification) → actions: retry (optionally stronger model),
edit ticket + retry, escalate, wont-do, kill stuck run.
Screens: S-10, S-05.

### WF-09 — Handle an escalation
Escalated queue → ticket shows unresolved questions + findings → claim:
answer inline (→ back into loop), forward to author (external), wont-do.
Screens: S-10 (queue), S-05.

### WF-10 — Audit / inspect the ledger
Ticket detail → Activity tab: LOG.md play-by-play, events.jsonl,
per-run artifacts (prompts, transcripts, usage.json, review.json,
reports) + per-ticket token rollup (in/out/cached by stage, cost where
computable, estimated flags). Replay any stage. Screens: S-05
(Activity), S-11.

### WF-11 — Take over a ticket / human handoff
From run monitor or ticket detail → "hand to human" → worktree+branch
preserved, handoff summary appended to ticket → human works locally →
"resume pipeline" returns it (re-enters at review).
Screens: S-05, S-07.

### WF-12 — Daily inbox loop (the actual day-to-day)
Open app → needs-attention inbox: questions pending, docs to approve,
reviews waiting, failures, escalations — clear each. Badge counts drive
order of work. This loop IS the product's daily surface.
Screens: S-01 (home), everything downstream.

### WF-13 — Settings & maintenance
Add/edit code repo (+repo card re-probe), rotate keys, switch backend,
change models, gate mode, timeouts, merge strategy, worktree root,
notifications, workspace add/remove.
Screens: S-02.

### WF-14 — Metrics / ROI check
Dashboard: tickets→merge rate, per-model success, cost-per-merge,
tokens-in/out per ticket + per stage (split out alongside $ — honest
across non-token-priced backends), human-minutes/ticket, fix-round
distribution, gate where tickets die — plus spec-quality panel:
deviation rate (headline), spec-score trend, spec-bug vs code-bug
finding mix. Screens: S-12.

### WF-15 — Approve a split plan
Inbox "split proposed on ABC-123" → split-plan view (child table:
titles, repos, depends_on, AC coverage map vs parent) → edit boundaries
→ approve (children land `imported`, parent → `split`) or reject
(back to author flow). Screens: S-06 variant, S-05 (family rail).

### WF-16 — Survey a product / refresh the knowledge base
Add code repo → repo-card probe + survey run queued (watchable in
S-07) → dossier lands in DB → KB screen shows sections + gap report.
Re-sync anytime via admin **Sync** button or scheduled refresh
(cron). Screens: S-14, S-02 (admin).

### WF-17 — Review & correct the dossier
KB screen → browse dossier sections (architecture, workflows, personas,
gaps) → correct wrong facts inline (agent proposes, human disposes —
edits are DB writes + ledger events) → confirm inferred personas.
Screens: S-14.

---

## 2. Screen inventory

| ID | Screen | Purpose | Key elements |
| --- | --- | --- | --- |
| **S-01** | **Needs-attention inbox** (home) | Every "your move" item across all tickets repos (unified + repo filter) | Grouped list: Questions / Approvals / Reviews / Failures / Escalations / Split-plans; ranked blocking-first→priority→age; spec-score badges (worst-specs-first grooming toggle); badge counts; snooze; claim (shared-queue) |
| **S-02** | Settings | All configuration | Tabs: General · Tickets Repos · Code Repos (+repo cards) · Backends & Keys · Models (main/review) · Gates & Budgets · Merge · Notifications · Worktrees · Advanced |
| **S-03** | Create / Import | Author or pull tickets | Tabs: **Interview** (seed text → wizard → ticket) · **Import** (source picker, JQL/milestone, preview+edit table) → commit |
| **S-04** | **Q&A wizard** | needs-info + design-Q&A + any agent→human questions | One question/card; options w/ `recommended` badge; "Other…"; mic (voice); skip=accept; "Accept all"; progress; bail-outs (force-ready, wont-do) |
| **S-05** | **Ticket detail** | Everything about one ticket | Status stepper across top (imported→…→merged); tabs: Overview (ticket.md, triage) · Documents (PRD/TDD/test + version diffs) · Activity (LOG/events) · Runs (artifacts, transcripts); right rail = current gate's action panel; **family rail** = parent/children + depends_on DAG for split families; spec-score badge in header |
| **S-06** | **Doc review page** | Approve PRD / TDD / test.md | Rendered markdown + paragraph comment threads; version diff; coverage-matrix view for test.md; approve / request-changes |
| **S-07** | **Live run monitor** | Watch any in-flight agent run | Transcript stream; current step vs plan; commits feed; elapsed + live in/out token counter + cost (streamed where the adapter supports it); kill / pause / hand-off buttons |
| **S-08** | **Code review page** | The centerpiece — approve code | Header brief (diffstat, AC traceability, spec compliance, **TDD addenda**, risk register, tech debt, highlights, commit story, test-report) · Changes tab (file tree, side-by-side diff, inline threads) · Issues tab (finding cards, verdicts, batch-fix) · approve→merge / send-back |
| **S-09** | PR status panel | Post-approve shepherd | CI checks; teammate comment threads (auto-fed badge); agent fix status; merge / revert buttons |
| **S-10** | Escalations & failures queue | Everything broken or returned | Filter by failed/blocked/escalated/aborted/doc-repair; reason + stage + log tail; retry (stronger model option) / edit / wont-do / claim |
| **S-11** | Ledger browser | Full transaction history per ticket | events.jsonl timeline; artifacts tree; per-run detail (prompt, transcript, outputs); replay/compare versions |
| **S-12** | Metrics dashboard | ROI proof | success rate, cost-per-merge, tokens-in/out per ticket + stage (in/out split + estimated flags), human-minutes, per-model stats, stage funnel |
| **S-13** | Workspace switcher | Multi tickets-repo | Repo/team list, per-repo queue counts, add workspace |
| **S-14** | **Knowledge base** | Product dossiers — the intelligence layer | Repo/product tabs; dossier sections (architecture, workflows, personas, UI map, docs, glossary, landmines); **gap report** panel; persona confirm/correct; survey status + last-surveyed + manual Sync; per-section edit with history |

## 3. Shared components (build once, use everywhere)

| Component | Used by |
| --- | --- |
| **Q&A wizard** (S-04) | interview mode, triage Q&A, design Q&A, test-plan Q&A, fix-triage |
| **Doc reviewer** (S-06) | PRD, TDD, test.md — any markdown approval |
| **Comment thread** (anchored) | doc paragraphs, diff lines, issue cards, PR comments |
| **Status stepper** | S-05 header, queue chips, inbox items |
| **Run monitor** (S-07) | triage, design, implement, review, fix, rebase, revert, survey, interview runs |
| **Ledger view** (S-11) | ticket Activity tab, audits, prior-art lookup |
| **Dossier viewer/editor** (S-14) | KB browsing, human corrections, gap report |
| **Markdown+frontmatter viewer/editor** | ticket.md, docs, context files |

## 4. Screens per status (state machine → UI map)

| Status | Where it surfaces | Human action |
| --- | --- | --- |
| imported | queue | none (auto-triages) |
| triage | — (auto run, watchable in S-07) | none |
| needs-info | inbox + S-04 wizard | answer / accept-all / bail |
| escalated | S-10 queue | claim / forward / wont-do |
| prd/tdd/test-draft→review | inbox + S-06 | comment / approve |
| ready | queue (auto-advances) | none (or forced override) |
| in-progress | S-07 monitor | watch / kill / handoff |
| review (auto-fix rounds) | S-07 (fix runs) | none until cap |
| changes-requested | inbox + S-08 | triage threads / fix |
| approved | inbox + S-08 | open PR (push + create, all repos) |
| pr-open / ci-watch | S-09 | shepherd / merge / revert |
| failed / blocked | S-10 | retry / fix env / wont-do |
| merged / reverted / wont-do / aborted | ledger (S-11) | — |

## 5. Decisions (Q&A 2026-10-03)

- **Multi-user**: multiple installs can point at the SAME tickets repo —
  shared queue. Everything carries attribution (git author + event
  `actor`); gated items get claiming so two humans don't answer the same
  wizard. Per-person assignment deferred. Claims/leases live in the
  coordination DB (see PRD storage architecture), with git-ref CAS as the
  zero-infra fallback.
- **Engine model**: **detached runs + persistent babysitter** — agent
  runs are detached OS processes; a lightweight conductor process
  (CONDUCTOR.md) watches them, collects artifacts on exit, lints,
  commits status, and auto-advances all non-gate transitions EXCEPT
  implement (human "go" = the spend checkpoint). Pipeline moves
  overnight; the app is a UI on an already-running conductor. Headless
  `sprint-runner daemon` = same engine, no UI, for team 24/7.
- **Inbox**: **both views** — unified inbox across all tickets repos as
  home (filterable), plus per-workspace boards for focused work.
- **Inbox ranking**: **blocking-first, then priority** — items blocking
  an agent's progress (Q&A, escalations) rank above items blocking a
  human step (approvals, merges); within a class, ticket priority then
  age. Keep machines unblocked first.
- **Wire contract** (2026-10-03): the UI talks to the conductor via
  REST + SSE (API.md) — bearer token on every request, `?token=`
  bootstrap on loopback only. Run control = SIGSTOP pause / SIGCONT
  resume / SIGTERM→SIGKILL kill. Screens read DB projections
  (`tickets`, `ticket_repos`, `gate_items`) — no direct file/git
  access in the frontend.
