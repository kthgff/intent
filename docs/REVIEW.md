# REVIEW — sprint-runner

Independent product review · 2026-10-03
Material: PRD.md, SCHEMAS.md, SETTINGS.md, MVP.md, UI-INVENTORY.md,
prompts/*, run-tickets.sh, README.md, sprints/2026-10/*

---

## Verdict

**This is an unusually well-engineered design doc — and a product whose
marketing is pointed at the wrong half of itself.** The pipeline
(orchestration) is solid but commoditizing fast: Devin, Claude Code,
Codex, and every vendor's "assign tickets to the agent" feature are
racing into that space natively. What's genuinely differentiated — and
undersold in the docs — is the **governance layer**: independent-model
review, spec-gated execution, a replayable per-ticket ledger, and
ground-truth verification. Framed as "batch-process tickets," this
competes with free. Framed as "audit and quality control for
agent-authored code," it has a real buyer and no direct competitor.

Design quality: above the bar. The trust boundaries (runner owns env,
agent proposes/human disposes, fail-closed everywhere, severity-gated
auto-fix) reflect someone who has actually run agents and eaten the
failure modes. The weaknesses are concentrated in three places:
**(a)** the shipped prompt set is incomplete — the pipeline literally
cannot run end-to-end as specified; **(b)** the ground-truth test report
has an unspecified linkage that undercuts its core claim; **(c)** the
shared-queue/multi-install story has a coordination hole at the human
gates.

---

## The Good

- **[GOOD] The tickets repo as transaction log is the crown jewel.**
  Per-ticket `events.jsonl` with cost/tokens/human-minutes schema fields,
  run artifacts, versioned docs (PRD §2). This is durable organizational
  IP — metrics substrate, prior-art corpus, and an audit trail that
  survives the product itself. Most agent tools produce PRs; this one
  produces *evidence*.
- **[GOOD] Ground-truth verification instead of agent self-report.** The
  runner independently re-runs the repo-card test command and produces
  `test-report.json` (PRD §6, SCHEMAS §10). This is the correct trust
  boundary — agents lie by omission constantly.
- **[GOOD] "Agent proposes, human disposes" applied consistently.**
  Mandatory `recommended` options, skip=accept-default, "Accept all
  recommendations" (PRD §6, prompts/triage.md rule 2). The wizard treats
  human attention as a budget, not a form field.
- **[GOOD] Triage self-answers factual questions** by reading the repo
  before asking humans (prompts/triage.md rule 1). This is the single
  highest-leverage design decision — it's the difference between a
  wizard and an interrogation.
- **[GOOD] Severity-gated auto-fix** (PRD §7.3): blockers/majors auto-fix,
  nits/questions batch to human triage. Auto-fixing LLM nits is how you
  churn working code; this design learned that lesson in advance.
- **[GOOD] Markdown tables with pinned columns for machine-read data**
  (SCHEMAS.md conventions). Far more robust for weak models than asking
  them to emit JSON mid-markdown — and human-diffable on github.com. The
  right format for the medium.
- **[GOOD] Capability-flag adapter contract** (PRD §2, SETTINGS.md).
  `can_exec`/`can_write_outside_tree`/`has_gh` lets weak harnesses like
  aider conform — the runner owns push, PR creation, artifact collection.
  This is what makes "pluggable backends" real instead of vapor.
- **[GOOD] Fail-closed posture throughout.** Malformed structured tables
  block the ticket (SCHEMAS.md lint rule); gitleaks failure blocks the
  commit (PRD §2); `verified: false` repo cards fail pre-flight
  (SETTINGS.md). The machine errs toward stopping — correct for
  unattended automation.
- **[GOOD] `blocked: env` vs agent failure taxonomy** (PRD §6). Metrics
  that can't distinguish "the world was broken" from "the agent failed"
  are worse than no metrics. This one can.
- **[GOOD] MVP cutline is honest and sequenced correctly** (MVP.md).
  Electron deferred until the pipeline proves value; review surface =
  real PRs on the tickets repo (dogfoods the ledger, zero UI code).
  This avoids the classic mistake of building the UI monument before
  the engine earns it.
- **[GOOD] Review prompt quality.** "Do NOT manufacture findings to look
  thorough. Zero findings is a valid, valuable result" (review-base.md
  rule 4) — most LLM-review prompts implicitly reward finding-fabrication.
  Explicit anti-slop guardrails like this are rare and load-bearing.

## The Bad

- **[BAD] The pipeline is missing prompts for entire stages.** `prompts/`
  ships triage, design, testplan, implement, review, fix, rebase — but
  there is **no PRD-generation prompt** (the `prd-draft` stage has
  nothing to run), and nothing for: repo-card auto-probe, GitHub/Jira
  importers, the shepherd's CI-failure fix runs, teammate-comment
  response, or escalation. "Locked/shipped prompts" (PRD §12 item 27)
  describes a set that cannot drive the state machine it's designed
  around. Highest-priority gap.
- **[BAD] `test-report.json` cannot verify `implemented: true` — the
  linkage is unspecified.** The schema requires per-case `implemented`
  booleans (SCHEMAS §10), but nothing defines how a planned `case_id`
  maps to a real test function in code. Does the case_id go in the test
  name? A comment tag? Without a convention, "planned coverage verified"
  is agent self-report wearing runner clothes — it hollows out the
  ground-truth claim the whole design leans on.
- **[BAD] Coverage lint forces fake cases for non-code files.** The
  matrix requires every TDD file-plan row → ≥1 `case_id` (SCHEMAS §4).
  A `config.yaml` edit or a docs file has no meaningful test case — the
  lint will either fail closed or pressure the agent into writing a
  `manual`/`assert true` case to satisfy the machine. Needs an
  `untestable`/`na` annotation in the file-plan `change` column so the
  lint enforces honesty instead of theater.
- **[BAD] Human-gate claiming has no mechanism across installs.** The
  shared-queue design relies on the coordination DB for claims/leases
  (UI-INVENTORY §5) — but in MVP there is no shared DB (SQLite is local;
  Postgres is daemon-mode, deferred). Git-ref CAS is specified only for
  stage-runs (PRD §6). So two teammates can both open the same wizard
  on the same ticket and collide on commit — exactly the failure the
  claiming feature exists to prevent. Either extend git-ref CAS to gate
  items or scope "shared queue" in MVP to single-human.
- **[BAD] Doc drift already present — the ledger contradicts itself.**
  PRD §12 item 19 still records "auto-fix all, ~2 rounds" while §7.3
  specifies severity-gated fixing (the adversarial-review fix that
  superseded it). The §2 ticket tree says `ticket.md`; §6's file table
  says `<id>-ticket.md`. The §6 state diagram omits `test-draft/
  test-review/test-approved` while SCHEMAS §1's enum includes them. The
  sample tickets use `repo:` (singular) and `status: todo` — neither
  exists in schema v1 (`repos:` list; `imported`). None fatal, but the
  docs enforce fail-closed lint on agents while failing lint on
  themselves.
- **[BAD] No cost budget anywhere.** 4 review passes × full-diff
  re-review × up to 2 auto-fix rounds = potentially 12+ full-diff LLM
  review calls per ticket, plus the shepherd's unbounded teammate-comment
  loop (PRD §8 has no cap — a chatty PR thread burns tokens forever).
  "Cost dial = review_model tier" (PRD §7.4) is a knob, not a budget.
  And `concurrency.implement: 0` (SETTINGS.md) defaults to *unbounded*
  parallel agent spend. For a product whose pitch includes
  cost-per-merge metrics, the absence of spend caps is conspicuous.
- **[BAD] Review-thread fingerprinting is underspecified → dedupe won't
  work.** `fingerprint` includes `symbol` and `line_range` (SCHEMAS §6),
  but nothing says who computes the symbol or how `line_range` stays
  stable after fixes shift lines. Agent-computed fingerprints across
  languages will be inconsistent — the `open→fixed→reopened` lifecycle
  depends on reliable matching and currently has none.
- **[BAD] "Layered spec package" is described but not implemented.**
  PRD §6 says small models get the tight version — but `implement.md`
  injects `{{TDD_MD}}`, `{{TEST_MD}}`, `{{PRD_MD}}`, and repo cards all
  at once, unconditionally. There's no token budget, no layered
  injection, and for a long TDD on a weak model this will blow context —
  exactly the failure the layering was designed to prevent.
- **[BAD] `can_write_outside_tree` reshapes prompts that don't have the
  conditional.** Only `implement.md` has `{{CAPABILITY_NOTES}}`. But
  `triage.md` instructs "Write `{{RUN_DIR}}/triage.json`", `design.md`
  writes to `{{TICKET_DIR}}`, `review-base.md` writes
  `{{RUN_DIR}}/findings.json` — all outside the code repo. With aider
  (`can_write_outside_tree: false`), every non-implement stage will emit
  artifacts into the wrong place or not at all.
- **[BAD] Triage prompt is single-repo in a multi-repo world.**
  `prompts/triage.md` takes `{{REPO_NAME}}` (one repo) and says "read-only
  access" — yet `repos:` is a list (cross-repo tickets are the norm per
  the design) and triage must *write* `## Triage` into the ticket file.
  The prompt as written can't inspect the second repo and contradicts
  itself on writability.
- **[BAD] `human_minutes` is a schema field with no collection
  mechanism.** Nothing defines how human time is measured (gate-open →
  gate-close? UI activity tracking?). The metric the product needs most —
  "does this save attention?" — will be garbage data or null.
- **[BAD] Sentinel contract is fragile against weak models.** Final-line
  sentinels (`DONE`, `BLOCKED:`, `NEEDS-INFO:`) are the stage's exit
  signal, but v0's parser greps the *whole log* (`run-tickets.sh` line
  251 — `tail -1` helps but still scans the entire transcript). A model
  that echoes "DONE" mid-plan or writes "BLOCKED:" in a code comment
  creates a false outcome. Contract should be: last non-empty line must
  match the sentinel regex exactly.
- **[BAD] Fix-run self-dismissal is an incentive hole.** `fix.md` lets
  the fixing agent declare findings "not a real issue" — the agent being
  corrected gets to overrule the corrector. It's surfaced in
  DEVIATIONS.md (good), but there's no rate cap; a weak/agreeable model
  can dismiss a reviewer's entire pass. Cap dismissals per run or
  require human confirmation above a threshold.
- **[NIT] No prompts for PRD, importer, probe, CI-fix, discuss.** (Folded
  into the first BAD finding; listed so it isn't lost.)
- **[NIT] `escalated` closes no loop in MVP.** Without tracker
  write-back, "returned to author" = an internal queue; the PM who
  authored the Jira ticket never learns why. Acceptable for MVP, but the
  gap should be named in the doc, not just §13.

## The Ugly

- **[UGLY] You're building "waterfall for agents" into a market fleeing
  toward vibes.** The industry's momentum is "let the agent figure it
  out"; this product is spec → approval → spec → approval → implement →
  review. That's not wrong — it's a *bet*: that for real teams the
  constraint isn't generation, it's trust. If that bet is right,
  sprint-runner is early and correct. If it's wrong (agents get good
  enough to trust raw), the spec pipeline is scaffolding the market
  removes. The design hedges correctly — gate modes compress to
  `minimal` — but the *identity* of the product is tied to the bet.
- **[UGLY] The pitch promises "tickets happen while you're in meetings"
  but the design bills you review time before anything merges.** Even in
  `plan-package` mode the human reviews a spec package AND the code. For
  a senior IC who would have reviewed anyway, this is a force
  multiplier. For anyone hoping for fire-and-forget autonomy, it's a
  letdown — the product saves *typing*, not *judgment*. The honest
  framing is "tickets get *implemented* while you're in meetings; your
  judgment is still the gate." Overselling autonomy is the fastest way
  this product gets dismissed.
- **[UGLY] By the time M6 ships, the orchestration layer will be
  commodity.** Devin, Claude Code, and Codex will all do "batch tickets
  → branches → PRs" natively. The moat is NOT the pipeline — it's the
  ledger, the independent-reviewer model, the spec-gating, and
  tracker/repo-agnosticism. The milestone plan builds the commodity part
  first (correct for validation) but the *product story* must be written
  around the durable layer now, or it'll launch positioned as a feature
  the vendors already absorbed.
- **[UGLY] The whole system's ceiling is prompt + model quality, and
  prompts are locked.** Locking prompts for v1 is right — but models
  churn quarterly and a locked prompt tuned for today's model drifts.
  The design has no prompt-eval loop: no golden-ticket suite that
  re-runs prompts against recorded sessions to catch regressions. The
  events ledger *is* the substrate for this — it's a missing product,
  not a missing test.
- **[UGLY] "sprint-runner" undersells the differentiator.** The name
  says "batch executor"; the differentiation is "review + audit for
  agent code." Anyone who evaluates the name against Claude Code's
  todo-batch mode will reach for the free tool before discovering the
  review surface, which is the actual product.

---

## Improvements (ranked by leverage)

1. **Write the missing stage prompts: `prd.md` (generation), `probe`,
   `import`, `ci-fix`, `escalate`, `discuss`.** The shipped set covers
   ~half the state machine. *Tradeoff:* none — it's completion, not
   scope.
2. **Define the case_id ↔ test linkage convention** (e.g., `@case:c1` in
   test name/doc-comment; runner greps test files for case_ids).
   Restores `test-report.json`'s "implemented" field to actual ground
   truth. *Tradeoff:* a small naming convention tax on generated tests.
3. **Add spend caps**: `review.max_rounds`, `shepherd.max_cycles`
   (teammate-comment loops), `budget_usd_per_ticket`, and default
   `concurrency.implement: 1`. Same anti-spin philosophy as the Q&A
   guards, applied to money. *Tradeoff:* occasionally a fixable ticket
   hits its budget and needs a human nudge.
4. **Extend git-ref CAS to human-gate items** (`refs/locks/claims/<id>`)
   so shared-queue works without the shared DB — or explicitly scope
   MVP multi-install to single-human. *Tradeoff:* more ref plumbing, or
   a smaller advertised feature.
5. **Make spec-compliance partly mechanical**: runner diffs the file
   plan vs `git diff --name-only` itself; the LLM pass only judges
   deviation *justifications*. Cheaper, more accurate, and one less
   review pass doing lint work. *Tradeoff:* none — it's strictly better.
6. **Doc-consistency pass**: reconcile item 19 vs §7.3, `ticket.md` vs
   `<id>-ticket.md`, state diagram vs status enum, and migrate the
   sample tickets to schema v1. The system lints agents fail-closed;
   its own docs should pass the same lint. *Tradeoff:* an hour.
7. **Capability-conditional artifact writes**: give every stage prompt a
   `{{ARTIFACT_TARGETS}}` block — absolute `runs/` paths when
   `can_write_outside_tree`, worktree-relative + runner-collection
   otherwise. Makes aider actually conform outside implement. *Tradeoff:*
   one more rendering variable.
8. **Fingerprint spec**: runner computes `symbol` (ctags/tree-sitter —
   the repo-map machinery already exists in design) or drop symbol and
   dedupe on `file + category + line-overlap + text_hash`. *Tradeoff:*
   either a small dependency or a weaker dedupe signal.
9. **Tighten sentinels**: "the last non-empty line of output MUST be
   exactly `SENTINEL: <value>`" — in every prompt and every parser.
   *Tradeoff:* none.
10. **Implement the layered spec package** the PRD describes: tiered
    injection (`must` layer always; `should`/`reference` layers by model
    class or token budget). *Tradeoff:* more render complexity — do it
    when weak-model runs show context starvation.
11. **Define `human_minutes` capture**: timestamp gate-surfaced vs
    gate-cleared events and report "gate dwell" honestly (with a stated
    idle-time caveat) rather than claiming measured attention.
    *Tradeoff:* the number will be noisier — and that's honest.
12. **Fix-run dismissal cap**: >N self-dismissed findings per run → all
    findings escalate to human. *Tradeoff:* occasionally a real
    mass-FP batch reaches the human — acceptable.

---

## Selling it

### Who buys

**Not vibe-coders.** The buyer is the person accountable for agent
output quality: engineering leads and platform teams at mid-size orgs
adopting agent coding (they have the review-bottleneck problem today),
and — the sharper wedge — **teams in regulated/compliance-adjacent
industries** where "show me the audit trail for this AI-authored PR" is
a question arriving in the next 18 months. Senior ICs running solo
sprints are the *beachhead* (they're free-tier, OSS users), not the
buyer.

### The wedge

First beachhead user: **a senior IC or tech lead already driving aider/
Devin/Claude Code on real tickets who has just been burned once by a
confidently-wrong agent PR.** That burn is the switch trigger — the
moment "I need to *check* this thing's work" outweighs "I want this
thing to be fast."

### The one-sentence pitch

> "Your agents write the code; sprint-runner proves it — spec-gated
> implementation, independent-model review, and a complete audit trail
> per ticket, ending in a PR a human actually trusts."

(Contrast with the current implicit pitch — "feed a directory of tickets
to an agent CLI" — which describes a weekend script, not a product.)

### Top 3 skeptical-buyer objections

1. **"Too much process — I'll just prompt the agent myself."** The
   design's best answer is real: gate modes (`minimal` = Q&A + code
   review only) plus "Accept all recommendations" compress the ceremony
   to ~2 human touchpoints. The honest answer underneath: *this product
   is for people who need the process* — audit, multi-repo, team
   visibility. If you don't, the free tool wins, and that's fine.
2. **"Why not just use Devin/Claude Code's built-in review and PR
   flow?"** Partially answered: backend neutrality, independent
   `review_model` (different family — no shared blind spots),
   multi-repo linked PRs, and the ledger. But the answer must be *led
   with* — right now the docs bury it under pipeline mechanics.
3. **"LLM-reviewing-LLM doubles my spend for uncertain gain."**
   Weakest answer today — no budgets, unbounded shepherd loops,
   unbounded default concurrency. Fix improvement #3 and this objection
   gets a number instead of a hand-wave: "a ticket costs $X to ship,
   measured, capped, and logged."

### Build-vs-buy framing

- **vs. using Devin/Claude Code directly**: they generate; this governs.
  The pitch isn't "more generation," it's "the control plane generation
  doesn't come with" — spec gates, independent review, audit trail.
- **vs. a homegrown bash loop**: the loop gets you tickets→PRs. It does
  not get you triage Q&A, spec artifacts, multi-pass review, ground-truth
  verification, or a replayable ledger. The question for the buyer is
  whether they need governance — if they do, homegrown costs months.
- **vs. Linear/Graphite/tracker-native AI features**: those are
  generation-plus-workflow inside one tracker. This is tracker-agnostic,
  backend-agnostic, and the artifacts live in *your* git, not their SaaS.

### Pricing shape (if productized)

Open-source the engine (it's the credibility engine + the wedge). Paid
tier = the team features: shared queue (Postgres/daemon), metrics
dashboard, tracker write-back, SSO/retention for the ledger. Roughly
$20–40/seat/mo or flat team pricing; enterprise = compliance features
(audit retention policies, air-gapped deployment, BYOK-only mode). The
free engine should be genuinely useful solo — that's what builds the
trust that sells the tier.

---

## The honest question

**Is this solving a real problem people have, or a problem people think
they have?**

**Real problem — with a caveat about which half is real.**

The *review/verification/audit* problem is real and growing: agent CLIs
now produce code faster than humans can evaluate it, "the agent PR"
review-fatigue complaints are already common in orgs adopting these
tools, and there is currently no good answer for "who checks the
agent's work, with what rigor, leaving what trail?" This design is
correctly weighted toward that problem — the review surface is the
centerpiece, ground truth comes from the runner not the agent, and the
ledger exists as a first-class asset. That's the real product.

The *"drive my tickets from a directory"* problem is the perceived
problem riding on top — it's real for a narrow slice of users today but
it's the part being commoditized by the vendors inside 18 months. If
this ships positioned as "a better ticket-batcher," it will be evaluated
against free features and lose. If it ships as "the governance layer
for agent-authored code," it has a differentiated answer to a problem
that's compounding.

The bet underneath it all: **trust, not generation, is the bottleneck.**
The design already behaves as if that's true (severity-gated fixes,
human-approve-always, fail-closed everything). The docs should say it
out loud.

---

## Bottom line

**Bones: strong. Framing: wrong. Biggest gap: the shipped prompts can't
run the pipeline they describe, and the flagship "ground truth" feature
can't yet verify the thing it claims.**

Do this, in order: complete the prompt set, specify the case_id linkage
and fingerprint mechanics, add spend caps, then run the M1 pilot on real
tickets — the events ledger will tell you the rest. Reposition the story
from "batch ticket runner" to "review + audit for agent code" before
anyone outside this repo sees it. The design earns that claim; the
current name and pitch don't yet.
