# Screen & Workflow Inventory — sprint-runner

Companion to `PRD.md`. Status: draft 2026-10-03.
Organizing principle: **the app is a pipeline Kanban with a
needs-attention inbox.** Home = two tabs: a **Board** (default) showing
every ticket in phase columns — "where is everything, what's left to
do" — and an **Inbox** list of every "your move" item. Card click opens
a **full-page ticket focus** view (inline gate action + chat-to-edit +
activity rail); heavy surfaces (monitor, code review, ledger) are
linked routes. (Revised 2026-10-03, D21/D23 — the board replaced the
inbox-only home; the slide-out drawer was rejected for space.)

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

### WF-12 — Daily loop (the actual day-to-day)
Open app → **Board**: see where every ticket sits, failed ones flagged
in-phase → flip to Inbox tab (or click attention badges) → clear:
questions pending, docs to approve, reviews waiting, failures,
escalations. The focus page clears most gates. This
loop IS the product's daily surface.
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

### WF-18 — Capture on an idea board
Project boards (named, Postgres) → drop typed stickies (thought/goal/
ambition/question/requirement/reference), text, docs, images, files,
links, voice notes; zones/frames group; comments discuss. Agents add
items too (survey gaps, findings — `source:` chip). Icebox parks.
Screens: S-15, S-16.

### WF-19 — Synthesize a board into an initiative
"Synthesize" on a board → extract-all run → S-04 Q&A wizard →
initiative `prd.md` draft + provenance.json (which items → which AC)
→ doc review → initiative lives. Consumed items freeze+dim; ship →
they light up `shipped`. Screens: S-16, S-04, S-06.

### WF-20 — Decompose initiative → features → tickets
Initiative decompose run → split-plan of features (AC coverage map)
→ approve → feature test-plans reviewed (batch-able, plan-package
default) → feature decompose → ticket split-plan → approve → tickets
`imported` w/ `feature:` → normal pipeline. Kanban delivery view on
the board tracks it all (full card actions). Screens: S-16, S-17,
S-06, S-05.

---

## 2. Screen inventory

| ID | Screen | Purpose | Key elements |
| --- | --- | --- | --- |
| **S-01** | **Home: Board + Inbox tabs** | Board (default): Kanban across 5 phase columns (Backlog·Spec·Build·Review·Done), unified workspaces, attention badges on cards, validated drag-drop; card → full-page ticket focus w/ inline gate action + chat-to-edit. Inbox tab: grouped "your move" list across all tickets repos, ranked human-anxiety-first→priority→age; spec-score badges (worst-specs-first toggle); badge counts; snooze (`gate_items.snoozed_until` — see §5); claim (shared-queue) |
| **S-02** | Settings | All configuration | Tabs: General · Tickets Repos · Code Repos (+repo cards) · Backends & Keys · Models (main/review) · Gates & Budgets · Merge · Notifications · Worktrees · Advanced |
| **S-03** | Create / Import | Author or pull tickets | Tabs: **Interview** (seed text → wizard → ticket) · **Import** (source picker, JQL/milestone, preview+edit table) → commit |
| **S-04** | **Q&A wizard** | needs-info + design-Q&A + any agent→human questions | One question/card; options w/ `recommended` badge; "Other…"; mic (voice); skip=accept; "Accept all"; progress; bail-outs (force-ready, wont-do) |
| **S-05** | **Ticket focus page** (operational hub — D25) | Know the next action, complete it, and work the ticket through docs, development, review, and release | Two columns: wide workbench + narrow **Status / What's left** rail. Inline **Next action** (human gate, active run, failure, or completion); tabs: Overview · Documentation (versioned PRD/TDD/test with MR-style diffs) · Activity (full S-11 ledger) · Runs + status-conditional spotlight (full Code review · Failure · Split plan). AI is contextual to ticket/document/code-review editing, never a permanent rail; **family rail** still applies for split families |
| **S-06** | **Doc review page** | Approve PRD / TDD / test.md | Rendered markdown + paragraph comment threads; version diff; coverage-matrix view for test.md; approve / request-changes |
| **S-07** | **Live run monitor** | Watch any in-flight agent run | Transcript stream; current step vs plan; commits feed; elapsed + live in/out token counter + cost (streamed where the adapter supports it); kill / pause / hand-off buttons |
| **S-08** | **Code review page** | The centerpiece — approve code | Header brief (diffstat, AC traceability, spec compliance, **TDD addenda**, risk register, tech debt, highlights, commit story, test-report) · Changes tab (file tree, side-by-side diff, inline threads) · Issues tab (finding cards, verdicts, batch-fix) · approve→merge / send-back |
| **S-09** | PR status panel | Post-approve shepherd | CI checks; teammate comment threads (auto-fed badge); agent fix status; merge / revert buttons |
| **S-10** | Escalations & failures queue | Everything broken or returned | Filter by failed/blocked/escalated/aborted/doc-repair; reason + stage + log tail; retry (stronger model option) / edit / wont-do / claim |
| **S-11** | Ledger browser | Full transaction history per ticket | events.jsonl timeline; artifacts tree; per-run detail (prompt, transcript, outputs); replay/compare versions |
| **S-12** | Metrics dashboard | ROI proof | success rate, cost-per-merge, tokens-in/out per ticket + stage (in/out split + estimated flags), human-minutes, per-model stats, stage funnel |
| **S-13** | Workspace switcher | Multi tickets-repo | Repo/team list, per-repo queue counts, add workspace |
| **S-14** | **Knowledge base** | Product dossiers — the intelligence layer | Repo/product tabs; dossier sections (architecture, workflows, personas, UI map, docs, glossary, landmines); **gap report** panel; persona confirm/correct; survey status + last-surveyed + manual Sync; per-section edit with history |
| **S-15** | **Boards list** | Idea boards per project | Board cards: name, item counts, unprocessed count, last synthesis, filter summary; + new board; archive |
| **S-16** | **Board canvas** | The idea space + delivery view | Freeform canvas: typed stickies (6 colors), text, docs, images, files, links, voice, zones, connectors, comments; **work layer** = kanban-by-status view w/ saved filter + **full card actions**; synthesize button; item states open→consumed→shipped |
| **S-17** | **Feature detail** | A delivery unit (S-05 anatomy) | Status stepper; docs tab (feature.md + test.md); AC slice; child tickets w/ status; gate panel; initiative + board links |

## 3. Shared components (build once, use everywhere)

| Component | Used by |
| --- | --- |
| **Q&A wizard** (S-04) | interview mode, triage Q&A, design Q&A, test-plan Q&A, fix-triage |
| **Doc reviewer** (S-06) | PRD, TDD, test.md — any markdown approval |
| **Comment thread** (anchored) | doc paragraphs, diff lines, issue cards, PR comments |
| **Status + remaining-work roadmap** | S-05 rail, queue chips, inbox items |
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
- **Inbox**: unified across all tickets repos (filterable). **Home is
  now the Board** (D21): 5 phase columns (Backlog·Spec·Build·Review·
  Done) collapsing the status enum; failed/blocked stay in-phase
  flagged; attention = badges on cards (in-column sort attention-
  first→priority→age); Done capped ~20 + "show more"; non-ticket
  gate items live in an ops strip above the columns; board snooze
  hides the card. Inbox survives as Home tab 2.
- **Board** (2026-10-03, D21): unified, filterable; cards = id/title/
  priority/sub-status + attention badges; drag-drop allowed for
  **human-meaningful transitions only** (wont-do, retry, claim — server
  validates via `drop_targets`, forward pipeline moves always
  rejected); KPI strip = per-column counts + WIP only (deep metrics
  stay on S-12); card → **full-page ticket focus** (`/tickets/<ref>/
  focus`): phase stepper + inline gate action + chat-to-edit +
  activity rail; monitor/review/ledger are linked routes (drawer
  design rejected for space, 2026-10-03).
- **Chat-to-edit** (2026-10-04, D25): contextual AI edits the current
  object — ticket.md, a selected PRD/TDD/test document, or a selected
  code-review finding/comment — never cross-ticket. It is absent from
  general page chrome and non-editing tabs. Reuses the interview run
  machinery (`POST /interview` + `ticket_ref` + `target` per SCHEMAS
  §16). No new run kind.
- **Focus page replaces S-05** (2026-10-04, D25): the card-click
  destination IS the ticket page. IA: inline Next action (current move
  only) · wide workbench tabs Overview/Documentation/Activity/Runs +
  status-conditional spotlight tab (full S-08 embedded in review,
  Failure detail, Split plan) · narrow Status/What's-left rail. **Doc
  versioning**: every persisted change to PRD/TDD/test = a version
  (agent + human/chat edits alike); version history + GitLab-MR-style
  before/after diffs between any two versions; Activity tab = full
  S-11 ledger embedded.
- **Inbox ranking**: **human-anxiety-first** — failures/escalations rank
  above routine agent Q&A/approvals; within a class, ticket priority
  then age. (2026-10-03, D21 — supersedes blocking-first: a broken
  thing outranks an idle agent. Applies to inbox list and card badge
  emphasis.)
- **Entity expansion** (2026-10-04, FEATURES.md): **project** =
  merged workspace+product (`workspace` stays the internal key);
  **initiative** owns prd.md+tdd.md (born of a board synthesis);
  **feature** = parent-with-docs unifying split families; tickets may
  be feature-scoped or project-scoped orphans. **DB-only storage**
  (tickets repo dropped — Postgres + append-only events + immutable
  doc versions). Screens S-15–S-17 added.
- **Snooze** (2026-10-03, design docs): S-01 items can be snoozed
  (defer without clearing) — needs `gate_items.snoozed_until` column
  + `/inbox` field; snoozed items are excluded from badge counts.
- **Wire contract** (2026-10-03): the UI talks to the conductor via
  REST + SSE (API.md) — bearer token on every request, `?token=`
  bootstrap on loopback only. Run control = SIGSTOP pause / SIGCONT
  resume / SIGTERM→SIGKILL kill. Screens read DB projections
  (`tickets`, `ticket_repos`, `gate_items`) — no direct file/git
  access in the frontend.
