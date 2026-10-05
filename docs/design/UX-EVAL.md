# UX evaluation — screens S-01…S-20

**Date:** 2026-10-04 · **Evaluator:** senior product-design pass (Devin)
**Scope:** `docs/UI-INVENTORY.md`, all `docs/design/s-*.md` specs,
`SCREEN-MATRIX.md`, `SCREEN-READINESS.md`, `DASHBOARD-FOCUS-REVIEW.md`,
`FEATURES.md`, `PRD.md`, `PRODUCT-MISSION.md`, `PRODUCT-DESIGN-REVIEW.md`,
all 23 mockup PNGs (desktop, compact, dashboard-focus set), and the two UI
implementations (`packages/ui/src/screens/*` production shell vs
`packages/ui/src/demo/DemoApp.tsx` which renders the mockups).

Method: hostile-but-fair review against five axes — spec fidelity,
attention economics, information hierarchy, consistency, state coverage —
plus a field-level audit per screen. Citations use the mockup filenames.

---

## Executive summary

The coded mockups are genuinely strong — the best screens (S-04 wizard,
S-05 ticket focus, S-07 run monitor, S-08 code review) already look like a
product people would trust. The design system (tokens, chips, glyph
vocabulary, empty/stale discipline) is coherent and honest — `~est` flags,
"Veto is working" ownership labels, and fail-closed evidence framing all
reinforce the thesis.

Three structural problems dominate, and none of them are on any single
screen:

1. **The shell doesn't contain the product's primary verbs.** "Capture an
   idea" and "start governed work" have no persistent entry point — no
   Create/Capture in the sidebar, no global `+`, no `⌘⇧C` modal mockup.
   Meanwhile two nav items (`Tickets`, `Review`) deep-link to a single
   hardcoded ticket. For a product whose tagline is *"Agents propose.
   Humans veto,"* the front door is missing from the frame.
2. **Home is not attention-first.** The product sells attention routing,
   but the default surface makes the user *scan* — five columns, badge
   hunting — and the Inbox mockup contradicts D21's anxiety-first ordering
   (failures/escalations render collapsed at the bottom). The daily job —
   *clear the queue* — has no flow of its own; it's spread across 8
   screens.
3. **The risky half of the product is the unmocked half.** Boards,
   capture/tray, initiatives, features, the `⌘K` palette, notifications,
   verify states — every surface added by D26/D27 is spec-only. The
   mockups prove the *execution* half of the pipeline and show nothing of
   the *intent* half.

Recommendation: **fix highs first, then redesign S-13 and the app shell.
The per-screen layouts do not need total redesigns — the navigation,
home model, and vocabulary do.**

---

## Cross-cutting findings

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| C1 | **No persistent Create/Capture affordance.** Sidebar has Home/Tickets/Review/Runs/Failures/KB/Metrics/Ledger/Workspaces/Settings. `s-03-create-import.png` exists only via the empty-state CTA and route. `⌘⇧C`, global `+`, and the S-19 modal are spec'd (UI-INVENTORY §3) but absent from every mockup's chrome. | blocker | Redesign the shell (see §Shell proposal): primary `+ Create` split-button (Ticket · Initiative · Feature · Board) + `Capture` button in the top bar, always visible. |
| C2 | **Dead-end nav items.** `Tickets` and `Review` in `DemoApp.tsx:278-287` link to one hardcoded ticket/review. There is no tickets-list screen and no global review queue in the inventory — these nav items promise pages that don't exist. | blocker | Remove both. The pipeline Board *is* the ticket list; the review queue is the Inbox `Reviews` group. Replace with Boards and Tray (spec'd anyway for D26). |
| C3 | **Inbox ordering contradicts D21.** `s-01-inbox.png` shows QUESTIONS and APPROVALS expanded on top; FAILURES, ESCALATIONS, REVIEWS, REPAIR collapsed at the bottom. D21/s-01-inbox.md requires failures + escalations ranked *above* routine gates, and collapsed-by-default hides the highest-anxiety items. | blocker | Reorder groups anxiety-first; default-expanded for failure/escalation; collapse routine groups only. Also fix group subtitle — "agents blocked" is wrong for escalations (they're returned to an author; nothing is blocked). |
| C4 | **"Review" column name collides with the `review` status.** The board's REVIEW column holds `approved/pr-open/ci-watch` (PR in flight); the conductor status `review` (agent self-review) sits in BUILD. A ticket "in review" is not in the Review column. | high | Rename the column **PR** (or "Merge") — BACKLOG · SPEC · BUILD · PR · DONE. Matches the user's mental model and avoids the collision. |
| C5 | **Identity drift across surfaces.** Mockups brand "Intent — From intent to evidence"; `App.tsx:68` brands "sprint-runner"; docs, config paths (`~/.config/sprint-runner`), and the repo say sprint-runner; PRODUCT-MISSION and PRD §13 both flag the name as wrong. Mockups also say "Workspaces"/"Products"/"All workspaces" everywhere vs D26's "project." | high | **Resolved 2026-10-04 — D35 ratified the name: Veto,** tagline "Agents propose. Humans veto." One mechanical pass lands it: brand, config dir (`~/.config/veto`), top-bar "All projects," sidebar "Projects," S-14 "Products" label → "Projects." Do it once, not gradually (PRODUCT-DESIGN-REVIEW §9 agrees). |
| C6 | **Accent convention broken.** design/README says "one indigo accent" for primary actions; every mockup renders primary CTAs in mint (Approve, Record, Merge 2 pull requests, Sync now, Propose edit). Mint simultaneously means "system/agent alive" (running dots, healthy chips) — the same hue now carries three semantics. | high | Pick one rule: **mint/green = system-alive + success outcome; indigo/blue = primary human action.** Recolor CTAs accordingly, or formally amend README to mint-for-action and find a different "agent working" hue. Don't leave it ambiguous. |
| C7 | **Two divergent UI implementations.** Production `screens/*` (flat top nav, "sprint-runner" brand, no board) vs `demo/DemoApp.tsx` — a 4,176-line monolith that renders every mockup with grouped sidebar, context bar, and the new ticket-focus page. The demo is the de-facto spec; production drifts behind it. | high | Promote the demo design system into the real component tree as screens get wired: tokens + shell first, then per-screen parity. Treat `DemoApp.tsx` as a prototype to carve up, not a codebase to grow. |
| C8 | **Unmocked surfaces are where risk concentrates.** No mockups exist for: `⌘K` palette, notification popover, Quick Capture modal, Global Create menu, S-15–S-20 (all of idea space), verify/UAT states, doc version diffs, plan-package/batch approval, split-plan, provenance editor, markdown editor, onboarding mode, stale-conflict (409) resolution. | high | Mockup these before build, prioritizing: shell overlays (⌘K/capture/create/bell), S-16 canvas + its list fallback, verify-confirm state, S-06 variants (plan-package, split-plan, provenance). |
| C9 | **No guided clearing flow.** WF-12's job is "clear the inbox," which today means visiting S-04 → S-06 → S-08 → S-05 → S-10 per item. Each screen is individually fast, but the *set* has no flow — the product optimizes per-gate cost, not queue-clearing cost. | high (design opportunity) | Add a **Focus/Do mode**: from Inbox, "Start clearing (9)" walks every gate fullscreen in ranked order — question → doc → finding → verify — with the next item always staged. Turns 8 surfaces into one session. This is the biggest UX lever available and it's purely additive. |
| C10 | **Badge semantics inconsistent.** Sidebar badges: Home 9 (gates — actionable), Review 2 (gates), Runs 3 (active runs — informational, not a "your move"), Failures 1. Mixing actionable and informational counts on identical badge chrome trains users to ignore badges — fatal for an attention product. | medium | Badge = open `gate_items` only (actionable); informational counts get a quieter style (muted, no fill) or move to a status line. Runs badge should count *stalled* runs, which are attention-relevant. |
| C11 | **Chip fatigue on rows/cards.** Board cards can carry kind badge + sub-status + claim + priority + running-state; inbox rows add spec-score glyph + ordinal number. Beyond ~3 signal-chips the eye filters them all out. The ordinal `01/02/03` on inbox rows carries no function (they're not hotkeys — `j/k` is). | medium | Chip budget: ≤2 signal chips + 1 meta per row/card. Drop the ordinals. Overflow goes to hover/tooltip or the focus page. |
| C12 | **Cost evidence dropped in the S-05 redesign.** The superseded detail page showed "Spent so far — $4.82 · 68.1k tokens · 6 runs"; `ticket-focus-*.png` Key facts lost it entirely. For the product whose implement gate is literally a *spend checkpoint*, cost should live on the ticket. | medium | Add Cost to Key facts (`$4.82 · 68k tok · ~est flag`) + a spend-vs-cap line when approaching `spend_cap`/`tokens_cap`. |
| C13 | **Multi-repo under-surfaced.** `repos: [api, web]` is a v1 contract, but ticket-focus Key facts shows a singular `feat/SR-0142` branch and no per-repo state. The S-09 PR panel is the only place repo multiplicity is legible. | medium | Key facts gains a Repos block: `api feat/SR-0142 · pr #842 · web feat/SR-0142 · pr #391` — compact rows mirroring S-09. |
| C14 | **Conductor-offline state absent.** Every screen shows "Live · Updated 8s ago" — but there's no designed state for the daemon/engine being down or SSE disconnected. In a localhost-served app this is the most common failure mode at startup. | medium | Global banner state: "Engine unreachable — retrying" (shell-level, all screens); `Live` chip degrades to `Stale · reconnecting`. |

---

## Per-screen findings

### S-01 Home Board — 8/10

What works: five-phase kanban over a 28-state machine is the right
coarseness; attention badges are labeled (never color-only); failed cards
stay in-phase with a red edge; ops strip keeps non-ticket gates honest;
WIP limits visible; honest empty state.

- [high] Attention requires scanning five columns. Even attention-first
  ordering means hunting badges. → Add a slim **"Your moves · 4"** strip
  between the ops strip and columns: horizontal gate chips (subject +
  kind + one-liner) deep-linking to the clearing surface. Keeps the map,
  anchors the queue. Alternatively default "Only my moves" on when
  count > 0 — weaker, acceptable fallback.
- [high] "REVIEW" column name collides with `review` status (C4). → Rename.
- [medium] `BUILD 3/2 OVER WIP` warns but doesn't act. → Link the warning
  to the `concurrency.implement` setting; it's a config signal, not a card
  problem.
- [medium] Column headers show count/WIP (`4 / 8`) but no indication of
  what's *blocked inside* — a user still scans card-by-card for the red
  edge. → Per-column attention count next to the total (`BACKLOG 4 · 1 you`).
- [low] Card claim initials + badges can collide on narrow columns. →
  Claim initials move to meta line when ≥2 badges.
- [low] Ops strip chips look static; they're actionable gates. → Same
  row-hover affordance as inbox rows.

### S-01 Inbox — 7/10

What works: grouped by kind with live counts, spec-score glyphs,
claim/snooze/keyboard vocabulary — the right bones for the product's
core loop.

- [blocker] Group order + collapse contradicts anxiety-first (C3). →
  Reorder: FAILURES · ESCALATIONS · REPAIR expanded first, then REVIEWS ·
  APPROVALS · QUESTIONS. Fix the "agents blocked" subtitle per kind.
- [medium] Batch approvals (D26's `batch-approve` kind, "approve all 5
  feature test plans") have no visible affordance. → Batch row type with
  subject list + single Approve-all (confirm shows the subjects).
- [medium] No sense of *queue cost*. → Header shows estimated clear time
  (`9 items · ~15 min` from per-kind medians) — sells "attention is
  measurable," and powers the guided flow's progress.
- [low] `x` snooze is hover/keyboard only — invisible to mouse users. →
  Persistent muted icon on row, or a visible "…" menu.
- [low] `●/○` blocked-vs-human dot is ~8px and subtle. → Keep glyph but
  pair with the existing `· agents blocked` subtitle (already done in
  group headers — extend to row meta for agent-blocked).
- [spec gap] `snoozed_until` is unimplemented — flagged in TRACKER; the
  design leans on snooze heavily enough that it's worth the schema row.

### S-02 Settings — 6/10

What works: capability detection row, "One blocking dependency" callout,
write-only secrets, risky-setting warnings — honest and operational.

- [high] The spec's tab list is now 13 sections (General, Projects,
  Backends & Keys, Models, Gates & Budgets, Merge, Notifications,
  Worktrees, Boards & synthesis, Verification, Survey, Security,
  Advanced) — Linear-style sub-nav collapses under that count; the
  mockup's tabs (Models/Pipeline/Products/Security/Notifications) match
  neither the spec nor each other. → Regroup into ~5: **Engine**
  (backends, runtime, models, permission mode), **Projects** (repos,
  cards, docs, app_url), **Pipeline** (gates, depth, budgets, merge,
  verification, survey), **Workspace** (boards, notifications, capture),
  **System** (security, worktrees, advanced). Amend s-02.
- [medium] "Products" tab + "workspaces" copy is stale vocabulary (C5).
- [medium] Blocking dependency deserves more than a rail note — gitleaks
  missing means commits can't scan. → Inline per-dependency install hint
  (`brew install gitleaks` copy button) in the status row.
- [low] `actor` required-unset highlight is good; also surface `actor`
  in the sidebar user card ("Keith Goff · operator") so identity is
  legible app-wide.
- [state gap] Onboarding stepped mode is spec'd but unmocked; first run
  should land on the seeded Getting-Started board, not a form
  (PRODUCT-DESIGN-REVIEW §8, ratified — needs the screen).

### S-03 Create / Import — 7/10

What works: the interview seed + spec-readiness ring + checklist is the
single best expression of the product's upstream thesis in the UI — it
*shows* spec quality forming. Prior-art banner is the differentiator made
visible.

- [high] Missing the entity selector (UI-INVENTORY: "Create
  Ticket/Initiative/Feature selector; parent/project picker") — mockup
  only does ticket-interview. → Segmented control at top: Ticket /
  Initiative / Feature (parent pickers downstream).
- [medium] Import preview/edit table (GitHub query → checkbox rows →
  priority/repo mapping → duplicate warnings) is spec'd but unmocked. →
  Produce the mockup; it's a table-heavy surface with real edge cases
  (column mapping, id collisions).
- [medium] "Product" field is stale; "Likely repos" shouldn't ask the
  user to guess — triage's `files_likely_touched` already suggests them. →
  Pre-fill from prior-art match; make it a confirmation, not a question.
- [spec question] Two front doors for ideas: S-03 interview (→ ticket)
  and S-19 capture (→ board item). A user with a rough idea faces a
  taxonomy question before they can think. → Unify the *entry*: one
  "New…" that lands everything in the tray by default, with a visible
  "interview this now → ticket" promotion on tray items. Capture stays
  zero-friction; interview becomes an upgrade path, not a fork.
- [low] Depth hint preselect exists in spec, not mockup — add it; it
  sets cost expectations early.

### S-04 Q&A wizard — 9/10

What works: one-question focus, `why` always visible, `★rec` with
rationale + evidence link, decision-note field (captures *why you chose*
into the ledger — quietly excellent), bail-outs muted, ticket context
rail. This is the product's best screen.

- [medium] No round indicator — spec header says `triage · round 2`;
  mockup shows only "Question 3 of 5." Rounds signal spin risk (cap at
  3) and matter to the user deciding whether to force-ready. → Context
  header gains `round 2/3` next to question progress.
- [medium] Prior answers aren't visible — answering question 3 blind to
  what you said in question 1. → Collapsed "Answered so far" accordion
  above the question card (Q1 → B, Q2 → A).
- [medium] Voice/mic affordance spec'd on text fields; absent. → Mic on
  the "Other" field + decision note (webview speech API; degrade
  silently).
- [low] Claimed-by-other read-only banner spec'd, unmocked — one state
  to capture.
- [low] `Accept all recommended` sits next to bail-outs; consider a
  primary-style distinction since it's the happy path, not an exit.

### S-05 Ticket Focus — 9/10

What works: Next action completed inline is *the* pattern — the page
answers "who moves next" in one glance; What's-left roadmap is
explanatory not decorative; "Veto is working" state is honest
ownership; contextual AI (composer inside the document, no permanent
rail) is exactly the right call vs the D24 AI column.

- [medium] Lineage breadcrumb (`IN-7 › FE-3 › SR-0142`) is spec'd but
  absent from the mockups — parent context is how orphan-looking tickets
  get meaning. → Add to header per spec.
- [medium] Cost/spend evidence dropped (C12); depth field dropped (old
  design showed `standard`); `forced` override flag dropped (old header
  showed it). → Key facts: + Cost, + Depth, + "forced ready · by KG"
  when set — audit-relevant honesty.
- [medium] Unmocked required states: failure recovery inline, split-plan
  spotlight, `verifying`/`verify-confirm`/released (D27), family/
  dependencies rail. → Capture each variant; they're conditional
  spotlight tabs, mostly new compositions of existing parts.
- [low] Roadmap lacks per-step *owner* — steps done by agents vs gates
  owned by humans read identically. → Small `you`/`agent` marker per
  step reinforces the attention contract.
- [low] `from board ▸` provenance link (spec'd) absent from Key facts.

### S-06 Doc review — 8/10

What works: evidence callouts, AC table with Given/When/Then, review
rail with score ring + coverage progress + anchored threads + decision
bar. The doc-as-contract reading experience is right.

- [high] All three load-bearing variants are unmocked: **plan-package**
  (3 docs, 1 approval — the D26 default!), **split-plan** (child table +
  AC coverage map + boundary edits), **provenance badge / trust-inheritance
  delta**. Plan-package being the *default gate mode* and having no
  mockup is the biggest single-screen gap. → Mockup all three.
- [medium] Comment → agent revision → new version flow is spec'd
  (`doc_feedback` run) but the round-trip UX (what the author sees while
  the agent revises, where the new version lands in the thread) is
  undesigned. → Thread shows "agent revising…" state + diff link on the
  reply.
- [low] Approve affordance doesn't show consequence. → Confirm copy:
  "Approve PRD v3 — creates a new version + clears the gate."
- [low] Coverage tab only exists for test.md — good; ensure the
  unmapped-row red treatment survives real data.

### S-07 Run monitor — 8/10

What works: transcript-as-hero with typed rows (SYSTEM/AGENT/TOOL/
RESULT/PASS), live token/cost/context strip with `~est`, heartbeat age,
plan stepper, artifacts. The `CONTEXT 41%` meter is a quietly great
addition — context pressure *is* the run's health.

- [medium] Spec's left **runs rail** (recent runs across all subjects,
  incl. `survey:`/`probe:`) is absent — mockup's left column is
  plan/artifacts. → Decide: a `/runs` list exists separately; either
  embed the rail (spec) or amend the spec. Embedding is better — run
  switching shouldn't cost a route change.
- [medium] Commits feed spec'd but unmocked. → Commit rows in the
  artifacts/right column, click → read-only diff.
- [low] Pause/Kill visible; **Hand off to human** (WF-11) is spec'd but
  not in the control cluster. → Add third control with its confirm.
- [low] Stall banner (`no heartbeat`) spec'd — capture the amber state.

### S-08 Code review — 8/10

What works: the brief strip is the best evidence-density in the app —
diff, AC traceability, tests, spec compliance + addenda, risk, commit
story in one row; findings rail with severity/fingerprint/rounds; the
`Send to fix / Dismiss / Wontfix` verdict vocabulary matches SCHEMAS
with no invented statuses.

- [high] The decision bar's Approve must be *disabled* with
  blocker/major open (spec) — mockup shows it enabled-looking with "5
  open findings · 1 blocker." → Disabled + tooltip "1 blocker must be
  resolved or dispositioned." This state is the trust contract made
  visible.
- [medium] Issues tab (batch-fix checkboxes, "send N to fix" bar, group-
  by-severity) and Test panel (DoD `verified_by` checklist, per-case
  rows) are both unmocked — only Changes + findings rail exists. →
  Mockup both tabs; the DoD checklist gates merge and needs the screen.
- [medium] `spec-bug → note to board` action (D26 — the spec-learning
  loop) is spec'd but absent from finding cards. → Fourth verdict on
  spec-bug findings.
- [low] "Compare round 1" dropdown exists — good; ensure "what changed
  since round N" diff-range toggle lands per spec.

### S-09 PR panel — 7/10

What works: two-repo merge order with the atomicity warning, checks per
PR, shepherd activity, single merge bar with strategy — multi-repo
shepherding is legible, which is rare.

- [medium] Teammate-comment feed with `auto-fed ⚡` badges + cycle
  counter (`n/5`) is spec'd but absent — the shepherd's *intelligence*
  is invisible. → Comments section per repo card with the badge + cycle
  state.
- [medium] DoD attestation checklist (merge enabled when `verified_by`
  rows run) absent. → Block in the merge bar: `DoD 3/4 · 1 manual attest`.
- [medium] No conflict/rebase/stale state — the multi-repo partial state
  (repo A merged, repo B conflicted) is the screen's hardest case and
  it's undesigned. → Mockup conflicted + partial-merged states.
- [low] Revert action spec'd, unmocked.

### S-10 Failures & escalations — 8/10

What works: case-file rows (classification, attempts 2/3, spent, log
tail, suggested recovery) — each row is a self-contained triage unit;
retry-with-escalation-model is the right ladder.

- [medium] Filter is a dropdown; spec has kind chips (All · Failed ·
  Blocked · Escalated · Aborted · Repair) with live counts. → Chips —
  the queue's shape should be visible without opening a menu.
- [medium] `stalled` rows (via notifications, not gate_items) and
  `verify_failed` (D27) unmocked. → Add both row variants.
- [low] Snooze still blocked on the schema field (TRACKER) — queue items
  linger; same fix as inbox.
- [low] "Forward to author" copies markdown for external reply — good;
  add the copy-format preview.

### S-11 Ledger — 7/10

What works: honest event timeline (actor chips, cost/tokens inline,
`~est`), payload inspector, commit-backed evidence links. The audit
surface reads like a ledger, not a log dump.

- [medium] Run-artifact tree (prompt/transcript/usage/review/test-report)
  partially shown — artifact browsing is the *reason* auditors come here. →
  Full artifact card per spec + compare-mode for any two usage.json /
  doc versions.
- [medium] Entity-kind filter (initiative/feature/board scope, D26) and
  the per-ticket token rollup strip are absent. → Add both.
- [low] Replay-eligible stages → deep link to S-07 with stored
  transcript — spec'd, worth one mocked state.

### S-12 Metrics — 6/10

What works: honest KPIs (`~est`, human-minutes with dwell caveat),
funnel with die-stages, spec-score trend, human-attention breakdown —
this is where the thesis gets proven or disproven.

- [high] D26's headline metrics are absent: **idea→merge/released lead
  time** (the marketing number), deviation rate **decomposed by
  `reason_kind`**, spec-bug vs code-bug mix, board yield, cost per
  feature. The KPI strip shows `DEVIATION RATE 7.4%` but the spec's
  §5 decomposition panel (the diagnostic half) is missing. → Rebuild the
  mockup per s-12.md's revised panel set; the current capture predates
  D26.
- [medium] Per-model table (model × stage → success/cost/fix-rounds)
  spec'd, absent. → Expandable table below the funnel.
- [low] Every number should drill to its ticket list — spec'd; needs the
  filtered-S-05 destination to exist first.
- [state gap] Empty/partial-data states ("metrics appear after first
  merge") unmocked; early adopters see this screen most.

### S-13 Projects — 3/10

- [blocker] Entire screen is the dead model: "Ticket repositories are
  the durable boundary" copy, git-URL cards, pull/sync verbs — D26/D29
  killed all of it (DB truth, project = repos + boards + dossier +
  initiatives). SCREEN-READINESS already flags it; confirming: this is
  the only screen needing **total redesign**. → Rebuild as project
  cards: health, repos + probe state, board count, open gates by kind,
  dossier freshness, in-flight runs; `Open →` scopes the shell.
- [medium] "Add a ticket repository" → becomes "Add project" (name +
  code-repo paths → probe queued). Remove/impact-confirm lives in S-02.

### S-14 Knowledge base — 8/10

What works: three-rail dossier browser, CONFIRMED/INFERRED persona axis
(the human-disposes ethic in miniature), gap report with severities,
survey freshness + sources, linked entities, version history.

- [medium] "PRODUCTS" rail label stale (C5); gap row action "File
  ticket" vs spec's "create board item" (D26 — gaps feed the idea
  funnel). → `→ board item` as primary, ticket as secondary.
- [medium] Correct-anywhere (select text → correct → `dossier_edited`
  event + human version) is spec'd but only persona-level Edit/Confirm
  is visible. → Mockup the selection-edit flow; it's the screen's core
  interaction.
- [medium] Entity graph/search spec'd — the typed-edge layer's only
  visual surface — absent. → Entities rail gains a graph/search mode or
  an honest v1 list + link-out.
- [low] Stale-diff view ("what the refresh flagged") spec'd — capture it.

### S-15…S-20 — spec-only, no mockups

Not scorable visually; flagged by readiness tracker. Design risks to
resolve *in the spec before mocking*:

- **S-16 canvas** is the highest-risk surface in the product: two visual
  languages (machine chrome vs paper canvas), canvas a11y, autosave,
  ingest states. → Require a **board-items list/grid fallback view**
  (solves a11y, ⌘K results, narrow screens, and cheap-implementation
  v1); capture the tray dock; mockup `new-since-last-run` default scope +
  cost preview.
- **S-15** spec is thin vs UI-INVENTORY (templates blank/PRD-prep/retro/
  research, stale counts, tray count, last-activity). → Reconcile the
  field set before mockup.
- **S-17/S-18** correctly clone the S-05 hub — but S-18's provenance
  two-pane editor (drag item → AC, ungrounded ⚠) is the novel surface
  inside; mock it first, it's the loop's evidence.
- **S-19 capture** — the philosophy is right ("capture must never become
  an interview"); ensure the tray's synthesize-selected flow shows the
  same cost-preview pattern as S-16.
- **Global overlays** (⌘K, capture modal, create menu, notifications,
  confirm/conflict modals) — spec'd in UI-INVENTORY §3, zero mockups.
  The palette is the power-user spine of a 20-screen app; it deserves a
  designed spec, not just a mention.

---

## Field-level audit

Fields spec'd in UI-INVENTORY/docs but absent or misplaced in mockups:

| Screen | Missing / misplaced field | Disposition |
| --- | --- | --- |
| Board card | per-column "you" attention count | add to column header |
| Inbox row | ordinals `01/02/03` | remove — dead weight |
| Inbox row | initiative cluster header (`IN-7 · 4 gates`) — spec'd | implement |
| Wizard | `round n/3`, prior answers trail, mic | add all three |
| Ticket focus | lineage breadcrumb, `from board ▸`, Cost, Depth, `forced` flag, per-repo branches | add (Key facts + header) |
| Ticket focus | `owner` field (FEATURES adds owner to tickets) | spec question — solo-tool semantics; show when set, hide otherwise |
| Code review | DoD `verified_by` checklist, spec-bug→board action, approve-disabled state | add |
| PR panel | `auto-fed ⚡` + cycle `n/5`, DoD rollup, conflict state, revert | add |
| Run monitor | commits feed, handoff control, stalled banner | add |
| Metrics | idea→released lead time, reason_kind decomposition, bug-mix, board yield, per-model | add (rebuild) |
| KB | gap→board-item, selection-correct, entity search | add |
| Settings | Verification tab (`verify_cmd`, `app_url`, `gates.uat`), Boards & synthesis tab | add under regrouped IA |
| Shell | Create menu, Capture, notification popover, engine-offline state | add all |
| Board item | `feedback` type chip (D27) | add to S-16/S-19 type vocabulary |

---

## Spec questions (deliberate decisions worth revisiting)

1. **Board as default home (D21).** The spatial map is real value, but
   the product's thesis argues the *queue* is home. Counter-position
   kept: keep Board default, add the "Your moves" strip — if after the
   pilot the strip is where mornings actually start, flip the default.
   This is measurable, not philosophical.
2. **`plan-package` as the universal default.** It's default for
   initiative work (D26) but `full` remains the documented default
   posture elsewhere. Given ~7 touches/ticket and the attention thesis,
   consider making plan-package the product default — `full` is for
   high-risk tickets, not the baseline. Gate cost is the product's
   self-inflicted tax; the default should be the cheap one.
3. **Owner field on solo-tool tickets.** `owner` shipped on
   initiative/feature/ticket for a product whose actor model is one
   config string. Keep it hidden until shared-queue is real — an
   ever-empty field is noise.
4. **Two idea-entry surfaces** (S-03 interview vs S-19 capture) — see
   S-03 spec question. Recommend the tray-first unification.

---

## Shell proposal (the one structural redesign)

```
┌──────────────────────────────────────────────────────────────────┐
│ ◇ Veto     ⌘K search-or-command…        [project ▾] [+▾] [⏺] 🔔 │
│                                        scope      create capture │
├──────────┬───────────────────────────────────────────────────────┤
│ TODAY    │                                                       │
│  Home  9 │  Board ⌄ Inbox …five columns…                        │
│  Queue 2 │                                                       │
│  Runs ●3 │  (● = stalled only — informational count, quiet)      │
│          │                                                       │
│ IDEAS    │                                                       │
│  Boards  │                                                       │
│  Tray 14 │                                                       │
│          │                                                       │
│ EVIDENCE │                                                       │
│  Ledger  │                                                       │
│  Metrics │                                                       │
│  KB      │                                                       │
│          │                                                       │
│ PROJECTS │                                                       │
│ ▾ team-a │   · boards 2 · gates 6 · dossier 3d                   │
│ ▸ portal │                                                       │
│          │                                                       │
│ KG ····  │   Settings                                           │
└──────────┴───────────────────────────────────────────────────────┘
```

Rationale: group names follow the product narrative (intent → work →
evidence) instead of entity types; Tickets/Review as nav items die (the
board and inbox cover them); Tray gets the capture count; Runs' badge
only counts anomalies. `+▾` = New Ticket/Initiative/Feature/Board →
S-03; `⏺` = Quick Capture → S-19 modal. Bell = the notifications
popover. Everything else persists.

## Priority fix list

1. C1+C2 — shell redesign: Create/Capture affordances in; dead nav out;
   group rename (Work / Ideas / Evidence / Projects).
2. C3 — inbox anxiety-first ordering + expanded failure groups + honest
   group subtitles.
3. C4 — rename Review column → PR.
4. C5 — name ratified **Veto** (D35); finish the one-pass vocabulary
   migration (project, config path, Products→Projects).
5. C9 — design the guided clearing flow ("Start clearing") — the daily
   loop's missing surface.
6. S-13 — total redesign to the project model.
7. S-12 — rebuild per D26 headline metrics.
8. S-06 — mockup plan-package (the default gate mode!), split-plan,
   provenance variants.
9. S-08 — approve-disabled state + Issues/Test-panel mockups + DoD.
10. C12+C13 — restore cost + depth + per-repo state to ticket focus.
11. Board "Your moves" strip + per-column attention counts (C3-adjacent).
12. C6 — fix the CTA accent rule (mint vs indigo).

## Verification

- Read: UI-INVENTORY (all 23 WFs + 20 screens + global surfaces),
  all 19 `docs/design/s-*.md`, SCREEN-MATRIX, SCREEN-READINESS,
  DASHBOARD-FOCUS-REVIEW, FEATURES, PRD, PRODUCT-MISSION,
  PRODUCT-DESIGN-REVIEW, MVP, TRACKER (D19–D30).
- Viewed: all 23 PNGs under `docs/design/mockups/` incl. compact +
  dashboard-focus variants.
- Code: `packages/ui/src/App.tsx` (production shell/routes),
  `packages/ui/src/demo/DemoApp.tsx` (mockup renderer — nav structure,
  route table), `packages/ui/src/screens/*` inventory.
- Not done: no live run of the demo app (review is mockup + spec +
  code based); no S-15–S-20 scoring (unmocked); UX-EVAL prompt's
  Playwright capture step not re-run — mockups were reviewed directly.

**Merge recommendation:** `fix highs first` — ship the shell redesign,
inbox ordering, vocabulary pass, and the S-13/S-12 rebuilds before the
next sign-off pass; S-15–S-20 need mockups before any build work.
