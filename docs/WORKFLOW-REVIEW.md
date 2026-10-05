# Workflow review — idea → production, end to end

**Status:** historical gap audit, reviewed 2026-10-04. The product decisions
that close these gaps were ratified in D27 and incorporated into `FEATURES.md`,
`PRD.md`, and `UI-INVENTORY.md`. “Missing” below means missing at the time of
the audit; most items remain implementation work, not unresolved product design.

Review date 2026-10-04. Walked the complete intended journey across
`FEATURES.md`, `UI-INVENTORY.md` WF-01…WF-20, and all screen docs
(s-01…s-17). Purpose: find the holes in the loop — not restate the
design. Verdict: **the middle of the pipeline is strong; both edges —
getting ideas IN and proving work is DONE — are underbuilt.**

## The journey as designed

```
0. SETUP      install → S-02 onboarding → project (repos+docs+survey)
                    → S-14 dossier builds
1. CAPTURE    S-15 → S-16 canvas: stickies, docs, images, links,
              voice, zones, connectors + agent items (survey gaps,
              spec-bugs, tech-debt, retro cards)
2. CURATE     arrange, zone, icebox, tag — topology = LLM grouping hints
3. SYNTHESIZE Synthesize → board-synthesize run → extract → S-04 Q&A
              → initiative prd.md + provenance.json → S-06 review
              → IN-x lives; consumed items freeze+dim
4. DECOMPOSE  initiative-decompose → split-plan → S-06 → FE-x rows
              feature-decompose    → split-plan → S-06 → SR-x tickets
5. EXECUTE    ticket pipeline: triage Q&A → spec (inherited delta) →
              design → implement ("go" spend gate) → S-08 review →
              S-09 PR shepherd → merge
6. SHIP       all descendants merged → board item → shipped →
              retro card written back to board
7. LEARN      spec-bug→board notes · dossier gaps→board · metrics:
              idea→merge lead time, cost/feature, board yield
   ── ops surfaces throughout: Home board/inbox, S-10 queue,
      S-11 ledger, S-12 metrics, S-13 projects, S-14 KB
```

## Critical gaps — the loop isn't actually closed

### 1. "Production" never happens — the loop ends at `merged`

The product promise is idea→**production**, but `shipped` is defined as
"all descendants merged." Merged ≠ shipped. There is no post-merge
stage: no deploy hook, no smoke test, no "confirm live" gate — and the
infrastructure to do it *already exists*: `app_url` + Playwright
screenshot crawler from the survey subsystem could verify the shipped
feature renders. Fix: a `verify`/`released` stage between merged and
Done — auto-run a smoke check against `app_url` (or a declared
`verify_cmd` on the initiative), or an honest human "confirmed live"
gate item. Without it, the flagship metric should be renamed
idea→*merge* (it already is — which quietly concedes the point), and
`shipped` on board items overstates reality.

### 2. The initiative — the largest entity — has no screen

FEATURES.md line 202 says "initiative detail = S-05 variant" but no
S-18 exists in UI-INVENTORY, SCREEN-MATRIX, or `docs/design/`. The
initiative owns the highest-stakes artifacts (the PRD+TDD the whole
tree inherits) and there's nowhere to see: its features rollup, its
board, its cost/progress, its provenance viewer, its gates. Users will
constantly want "show me IN-7." Needs an S-18 design doc — S-05/S-17
anatomy: stepper, prd/tdd docs tab, feature rollup w/ status,
provenance browser, gate panel, board link.

### 3. Synthesis is irreversible — no undo

Consumed items freeze forever at step 3. If the run produces a bad
initiative — wrong scope, hallucinated requirement — rejecting the PRD
in S-06 leaves the items consumed anyway. There is no `unconsume`,
no "reject synthesis → items return to open." Real users hit this in
week one. Fix: initiative `rejected`/`discarded` status that releases
`consumed` items back to `open` (provenance deleted, not superseded —
provenance must not drift, but it must be *correct*).

### 4. Synthesis is whole-board only

"One board → many PRDs" was ratified, but the only mechanism is
sequential whole-board passes over *new* items. There's no "synthesize
this zone" or "synthesize my marquee selection" — the natural way
people actually scope work ("just the onboarding cluster"). Zone
topology is already serialized into the extract; adding a `scope:
zone|selection|new-items` parameter is cheap spec surface with big
usability payoff.

### 5. No quick capture — the front door has friction

Every capture path requires: open app → S-15 → pick board → click
sticky tool → place it. Ideas die at that cost. Missing: an
**unprocessed tray** — a capture inbox where items land fast (CLI
`intent add "…"`, global hotkey, share-sheet, email/webhook, mobile
web view), then get triaged onto boards later or swept up by the next
synthesis run as `source: tray` items. The tray also solves the mobile
story without a canvas port. This is the single highest-leverage
addition for an idea-capture product.

### 6. Board is the only way to create structured work

S-03 makes tickets; the board makes initiatives. But there's no
"New initiative" / "New feature" — a user who knows exactly what they
want must still perform the board ritual (or hand-author markdown in
the right directory). Add create-actions: blank initiative (triage→
prd-draft), initiative-from-template, feature-under-initiative. Same
Q&A wizard, just a different entry point.

## Missing features — things a user will ask for within a month

### 7. No mid-flight re-planning

Initiative in flight, scope changes: a feature is too big, the market
moved, a feature should split again. There is no `re-decompose` —
split machinery only runs once, forward. Need a **re-plan action** on
initiative/feature: re-run decompose against remaining ACs; already-
delivered children stay terminal, new children materialize. (The
"specs are cheap, judgment isn't" thesis guarantees this is common.)

### 8. Provenance is write-once, never correctable

`provenance.json` maps items→ACs at run time; if the run misattributes
sticky-3 to AC-5, nobody can fix it — and everything downstream
(delta views, shipped tracking, lead-time) inherits the error. Needs
a correction affordance in S-06/S-18: "link/unlink item to this AC"
→ writes a provenance amendment event (append-only, so history stays
honest).

### 9. Question budget not enforced

The user said "up to 15 questions" during synthesis. Nothing encodes
that — `spec_depth` exists per ticket but synthesis has no question
cap, and no defined overflow (round 2? force-draft?). Add
`synthesize.max_questions` (default 15) + overflow = draft with
explicit `open_questions` section in the PRD.

### 10. Chat-to-edit is ticket-scoped only

`POST /interview` takes `ticket_ref`; targets = ticket|prd|tdd|test.
Initiative/feature docs can't be edited conversationally — a weird
asymmetry when they're the most important docs in the tree.
Generalize to `subject_ref` (`IN-7`, `FE-3`, `SR-142`) + same
ticket-dir-scoped diff rules applied to the entity's doc dir.

### 11. No owner, no priority, no ordering above tickets

Tickets have P0–P3. Initiatives/features don't — so "which of my 3
initiatives does the machine work first?" has no answer; pipeline
order is insertion order. And no `owner`/`assignee` anywhere — fine
for solo, broken for the "shared queue" the DB already half-supports
(`claimed_by` exists on gates; nothing owns work). Minimum:
priority on initiative/feature (ordering) + optional owner.

### 12. Synthesis doesn't read the knowledge base

The extract serializes board contents — and nothing else. The project
**dossier** (S-14: architecture, landmines, personas, workflows), the
single richest context the system owns, is absent. A synthesis run
that doesn't know the codebase will write greenfield PRDs for a
brownfield product. Add dossier + `prior_art_recall` + semantic
dedupe (config keys already exist — `semantic.*`, `prior_art_recall`)
to the extract step: "existing tickets/features that overlap" should
also be flagged as *conflicts* pre-draft, not discovered in review.

### 13. Nothing resurfaces stale ideas

Items rot in `open` silently. The product routes attention for gates
but never for decaying ideas. A periodic "stale items" surface —
board digest ("12 items untouched 60d"), an inbox suggestion kind,
or auto-icebox prompts — keeps the capture habit alive and feeds
board yield metrics a second input: ideas that *should* die vs ideas
that got lost.

### 14. No cost preview on expensive runs

`implement` has the "go" spend checkpoint. `board-synthesize` —
serializing an entire board incl. docs+images+transcripts through an
LLM — fires blind. Put a rough estimate on the Synthesize confirm
("~14 items, ~$2–4 on sonnet") matching the spend-checkpoint honesty
of the rest of the product.

## Missing features — smaller, still real

- **Release artifact**: the ledger knows exactly which tickets/ACs
  merged per initiative — auto-generate `CHANGELOG`/release notes on
  `delivered` (+ optional gh release). Nearly free, ships the story.
- **Production feedback ingestion**: shipped features generate signal
  (bug reports, Sentry, user complaints) — a `feedback` item source
  (webhook/manual) → board closes the true idea→prod→learn loop.
  Retro cards are internal reflection; this is external signal.
- **Global search scope**: `⌘K` should cover board items, doc
  contents, features/initiatives — not just ticket ids.
- **Board templates + seeded onboarding board**: previously flagged
  as steal-worthy, never specced. First-run should land on a board
  pre-loaded with example stickies the user can synthesize in 2 min —
  the product demoing itself.
- **Re-parent/move**: ticket→different feature, feature→different
  initiative, orphan→feature. Lineage edits via an `reparent` action +
  event; provenance preserved.
- **Cancel semantics**: `wont_do` on an initiative/feature — does it
  cascade to open children? Unconsume its board items? Undefined.
- **Cross-initiative dependencies**: canvas connectors hint at
  relationships but nothing blocks FE-3 on FE-7 from a different
  initiative. `depends_on` exists for split children only.
- **Deliberate omission to ratify**: no sprints/dates/velocity —
  timeboxing is Jira's other half and it's absent. Probably right for
  an attention-budget tool, but decide explicitly (D-log) rather than
  discover it later.

## Missing steps inside existing flows

| Step | Gap |
| --- | --- |
| Onboarding | no seeded board; survey runs but never offers "survey findings → board" starter items as the demo path |
| Synthesis Q&A | questions don't cite the sticky they were mined from (spec'd in s-04, needs provenance pre-link in the run output) |
| Split-plan approval | no "what changed" when a re-plan regenerates a plan (needs re-plan first, #7) |
| Review→merge | no `qa`/`uat` human-verify status between approved→pr-open for teams that hand-test |
| Merge→shipped | see #1 — no verify stage at all |
| Retro | fires on `delivered` only; a partially-failed initiative (3/5 features shipped, 2 wont-do) gets no retro — arguably when it's most valuable |

## What I'd fix first

1. **Verify stage** (#1) — it makes the marketing claim true and it's
   mostly existing machinery (app_url crawler + a gate kind).
2. **S-18 initiative detail** (#2) — the missing home for the entity
   everything inherits from; also the natural host for provenance
   editing (#8) and re-plan (#7).
3. **Unconsume + scoped synthesis** (#3, #4) — correctness issues,
   not features; users will corrupt their own boards otherwise.
4. **Unprocessed tray / quick capture** (#5) — the funnel's front door.
5. **Dossier + prior-art in synthesis extract** (#12) — spec-quality is
   the differentiator; feeding it the best available context is the
   highest-leverage prompt change in the system.

Everything else is real but survivable until these five land.
