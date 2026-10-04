# Product design review — intent / sprint-runner

Reviewer: product design pass · 2026-10-04
Material: all `docs/*.md`, design docs, PRODUCT-MISSION, REVIEW,
the idea-board/feature/project session (2026-10-04), codebase state.

---

## Verdict

**The product just found its missing half — and now risks drowning it
in hierarchy.** "Idea → production" is the correct north star and the
idea board completes the story the specs were circling (interview mode
was always a form pretending to be a thinking space). But the emerging
model — project → PRD+TDD → feature → ticket, plus boards with
Jira-style filters — is one layer away from rebuilding Jira's weight
inside a tool whose whole thesis is *less ceremony, more judgment*.
The design work now is subtraction: keep the new entities minimal and
unify them with what exists, or the attention budget you sell gets
spent on your own object model.

## What the product is now

```
idea ──► board ──► PRD ──► feature ──► ticket ──► merged PR
 (capture)  (synthesize)  (decompose)   (implement)   (verify)
```

Every stage maps to a shipped mechanism except the first two — which is
exactly why the product felt like it started mid-thought. This review
treats the board/model as decided (per 2026-10-04 session) and reviews
the product that results.

## Strengths worth protecting

- **Inbox-as-home.** The needs-attention queue is still the right
  daily surface. Nothing below replaces it.
- **"Agent proposes, human disposes"** — wizard recommendations,
  accept-all, human-approved gates. The board synthesis must inherit
  this ethic, not bypass it.
- **Provenance instinct.** Consumed items staying linked+dimmed is
  right; extend it (below).
- **Agents can write to the board.** Survey gaps and findings landing
  as board items is quietly the best idea in the new model — the KB
  stops being a report and starts feeding the funnel.

## Holes & gaps

### 1. Two family models — unify or drown

The codebase already has `parent:` + `depends_on` + `split` families.
"Feature" is a parent with real docs (test plan, AC slice, gates). If
features ship as a *new* parallel concept you get two trees to
explain, migrate, and render. **Unify:** a feature IS a parent subject
with a docs contract — extend the split-family machinery rather than
building a second hierarchy. The family rail in S-05 already renders
the shape.

### 2. The PRD is an entity, not a doc — name it

User model: project → PRD (board synthesis output, initiative level)
→ features → tickets. A "PRD" that owns decomposition, status, and
children is not a markdown file — it's a container entity. **Call it
an `initiative`** (or epic): `initiatives/<id>/` holds `prd.md` +
`tdd.md`; `features/<id>/` holds `feature.md` + `test.md` + AC slice;
tickets reference `feature:` in frontmatter. One `subject` type each —
they already exist (`survey:`, `import:`…), so gate_items, leases, and
the inbox extend naturally. Naming it "PRD" will collide forever with
the per-ticket `prd.md` that already exists.

### 3. Gate explosion — the attention math gets ugly

Full pipeline today: ~7 human touches per ticket. Under the new model
a 5-feature initiative × 3 tickets each = 15 tickets, 5 features —
each with test-review gates + two split-plan approvals + the
initiative's PRD/TDD reviews. That's potentially **40+ human touches
per idea**. This contradicts the product's core promise.

Mitigations (all needed):

- **Default `plan-package` for initiative work** — one combined doc
  gate per feature, not three.
- **Batch approvals in the inbox** — "approve all 3 split-plans" /
  "approve this feature's test plan" as one item.
- **Feature-level trust inheritance** — approving the initiative PRD
  should mark feature drafts "pre-approved context"; the human reviews
  deltas, not whole docs.
- Make gate counts a first-class UI element — an inbox section header
  that says "Initiative X: 4 gates to clear" keeps the cost visible.

### 4. The board's work layer is a second inbox — bound it

A Jira-style filter pulling tickets onto the canvas duplicates
S-01/S-10/S-13 — two places to do the same job splits attention, the
thing you sell. Rules:

- Work-layer cards are **read mirrors**: status, progress, link out to
  S-05/S-07. No gate actions on the canvas. The inbox stays the only
  place you *act*.
- The filter defaults to **this board's spawned work** (provenance),
  with project/PRD/feature/status as adjustable criteria — that's the
  Jira muscle memory the user described without inventing a second
  queue.
- Frame it as **delivery view**: columns by status group (spec'ing /
  implementing / reviewing / done) — kanban familiarity, zero new
  interaction model to learn.

### 5. The loop doesn't close — ideas never learn they shipped

Idea → merged PR is still not "production." The board knows the idea;
the ledger knows the merge; nothing connects "the thing you
stickied in March shipped in June and here's the deviation story."
This is the emotional payoff of the product and it's missing:

- Board items get a **`shipped` state** when their descendant tickets
  all merge — the consumed item lights up, not just dims.
- Feature/initiative completion writes a **closing summary back to the
  board** (agent-authored card: what shipped, deviation rate, cost,
  open threads) — the ledger feeding back upstream.
- Spec-bugs found in a feature's tickets should auto-suggest a board
  note on the initiative ("PRD ambiguity at ac3 — pattern worth
  fixing") — the spec-bug feedback loop reaching the idea layer.

### 6. Synthesis is lossy — keep a provenance map

"Whole board → PRD" is right, but if the PRD doesn't record *which
stickies became which AC*, the audit story breaks at the exact point
the product claims to start. Synthesis emits `provenance.json`: every
AC row + every requirement → the board item ids that informed it.
Renders as "grounded in 12 notes" badges in the doc review; a human
can click an AC and see the sticky. Nobody else has requirement→
sticky-note traceability; it's cheap (one more artifact) and it's the
kind of evidence the ledger story is built on.

### 7. Metrics don't reach the new top of funnel

Today's dashboard starts at `imported`. The product story now starts
at a sticky note. New headline metrics that follow:

- **Idea→merge lead time** (board item `created_at` → last descendant
  merge) — the real "idea to production" number; currently
  unmeasurable, becomes a schema field away.
- **Cost per feature**, not just per ticket.
- **Board yield**: % of items that reach merged code; % discarded —
  tells users whether their brainstorms actually produce.
- **Spec score at initiative level** — aggregate of children.

### 8. Onboarding still starts in the wrong place

WF-01 ends at "settings configured." With boards, the first-run arc
should be: create project → land on an **empty board pre-seeded with
example stickies** ("a thought", "a goal — connect it", "drag me to a
zone") → the user's first PRD can be synthesized from the seed
content. The product teaches itself in its own medium. Current
onboarding dumps you in a form.

### 9. Smaller gaps

- **Agent-written board items need a `source: agent` provenance chip**
  + optional "suggested" lane (user said agents add freely — fine, but
  mark it and let `board.agent_items: lane|free` tune it; a weekly
  survey shouldn't dump 40 items unlabeled).
- **No feature priority/ordering** — initiatives need the same
  priority field tickets have, plus a display order for the work
  layer.
- **Board ↔ workspace rename is spec-wide surgery** — "project"
  replacing workspace+product touches `tickets_repos`, `products:`,
  every `workspace` DB column, S-13, and all docs. Decide the rename
  once (see naming note) and do it as one mechanical pass, not
  gradually.
- **Orphan tickets inside a project's board** — fine, they show in the
  work layer with no feature badge. Make sure the filter treats them
  as project-scoped (decided), not invisible.
- **Consumed-item editing** — once consumed, items should freeze
  (they're provenance now); edits post-consumption would falsify the
  trail. Allow "supersede" = new item linking the old.

## New ideas (ranked by leverage)

1. **The board teaches the product** — seeded onboarding board
   (§8 above). Costs one fixture; converts setup friction into
   first-value in minutes.
2. **Idea→production lead time as THE marketing metric** — "this
   sticky note became merged code in 6 days at $4.20." No competitor
   can print that number.
3. **Provenance map** (§6) — AC→sticky traceability; makes the PRD
   review page show its receipts.
4. **Board templates** — "release planning", "bug bash", "customer
   complaints" zones pre-laid-out. Cheap JSON presets.
5. **Retro card on completion** — when an initiative finishes, an
   agent card lands on the board: cost, deviations, spec-bug patterns,
   "what we'd spec differently." The ledger learning to talk back.
6. **Voice-first capture** — a mic button *on the board itself*
   (record → transcribe → sticky). Thinking shouldn't require typing;
   the speech path already exists for wizards.
7. **Cluster-suggest pass** — periodic cheap run proposing "these 6
   notes look like one initiative" with a lasso preview. Optional, off
   by default, earns trust.
8. **Icebox** — a parked zone per board; items in it are excluded from
   synthesis. Cheaper than deleting, honest about "not now."
9. **PRD-level spec score** — roll children's lint scores up so a weak
   initiative glows before it spends tokens decomposing.
10. **Board as escalation destination** — `escalated` tickets can
    bounce back to a board card ("return to thinking space") instead
    of just a queue row — acknowledges that some tickets are failed
    *ideas*, not failed runs.

## Model recommendations (concrete)

- **Entities:** `project` (merged workspace+product — rename
  everything once, `workspace` DB column stays as the physical key,
  rename display language only if schema churn is too costly);
  `board` (Postgres: items, zones, links, filter config);
  `initiative` (tickets-repo dir + DB projection; prd.md + tdd.md);
  `feature` (dir + projection; feature.md + test.md + AC slice +
  `parent:`-style children). Ticket gains `feature:` frontmatter;
  feature gains `initiative:`.
- **Screens:** S-15 boards list, S-16 board canvas (idea layer +
  delivery-view toggle + filter bar), S-17 feature detail (S-05
  anatomy: stepper, docs, children, gate panel). Initiative detail =
  S-05 variant too — don't build a third layout.
- **Inbox:** add a group header per initiative so gates visually batch;
  new kinds: `initiative-doc-review`, `feature-test-review`.
- **Prompts:** `board-synthesize.md` (extract → questions → PRD +
  provenance), `initiative-decompose.md`, `feature-decompose.md` —
  reuse the split-plan schema for both decompositions.
- **Gates:** initiative PRD/TDD reviews share the S-06 surface;
  feature test plans share it too. No new reviewer needed — the doc
  reviewer is already generic.

## Risks

- **Jira-fication.** "Like Jira" is a useful interaction shorthand and
  a dangerous product spec. Jira's failure mode is that the hierarchy
  becomes the work. Guardrail: no entity gets added without a gate or
  a deliverable attached; if a level exists only to organize, it
  should be a board zone, not a schema row.
- **Two truth sources.** Board in Postgres vs tickets repo in git —
  decided, but keep the rule clean: git = approval/audit truth (PRDs,
  features, tickets), Postgres = idea-space + query layer. The
  moment a board item carries approval semantics the model muddies.
- **Scope avalanche.** This session added: canvas engine, new entity
  tier, renamed project model, agent-write surface, synthesis run.
  That's ~3 months of surface on top of an engine that (per
  PRODUCT-MISSION) still can't be launched. Sequence: launch the
  current engine end-to-end first, then board — or accept that the
  board IS the launch and cut elsewhere (desktop shell, daemon).
- **Attention promise vs feature count.** Every new surface is a new
  place to check. The board must earn its notification budget — an
  unsynthesized board should be silent, not a second badge.

## Priority order (if it were my roadmap)

1. Launch what exists (CLI entrypoint + conductor serving the UI) —
   the product can't be used today; everything else is moot.
2. `human_minutes` + deviation rate — make the two headline metrics
   real; they're the proof the thesis works.
3. Board v0: canvas + typed items + zones + synthesis run → PRD +
   provenance map. No work layer yet.
4. Initiative/feature entities via the unified parent model;
   decomposition reusing split machinery.
5. Delivery-view work layer on the board + feature detail screen.
6. Metrics extension + retro cards + shipped-state closing of the
   loop.
7. Templates, icebox, cluster-suggest, voice capture — the polish
   layer.

---

## The one-line version

**Stop at four nouns — project, board, initiative/feature, ticket —
make the board earn its place in the attention economy it serves, and
close the loop so ideas can see themselves ship. The differentiation
was always the ledger; now the ledger just got a beginning to match
its end.**
