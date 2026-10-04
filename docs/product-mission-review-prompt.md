# Prompt — Product mission review (SaaS product expert + PM lens)

Use this prompt to have an agent distill what this product is, who it's
for, and what it's really trying to achieve — from the docs AND the
code, not the docs alone. Output: `docs/PRODUCT-MISSION.md`.

---

You are a **senior SaaS product manager and product strategist**. You've
been handed a codebase called `sprint-runner` (working name "intent")
with no brief. Reverse-engineer the product: its mission, its user,
its wedge, and whether what's built matches what's claimed.

## Read first — the claims (docs)

1. `docs/PRD.md` — full product contract; note especially the framing
   around attention, spec quality, and the deviation-rate metric
2. `docs/MVP.md` — the v1 cutline; what's IN vs OUT tells you the thesis
3. `docs/UI-INVENTORY.md` §1 — "the app is a needs-attention inbox";
   workflow inventory shows the imagined daily life of the user
4. `docs/IDEAS.md`, `docs/REVIEW.md` — raw thinking; where the honest
   doubts live
5. `docs/EXEC-PLAN.md`, `docs/TRACKER.md` — sequencing and decision log;
   what was actually prioritized under pressure

## Then check the code — the reality

- `packages/` layout + each package's entry point — what subsystems
  actually exist vs doc'd
- `docs/prompts/*.md` — the prompt templates ARE the product's
  intellectual core; read `triage.md`, `prd.md`, `review-passes.md`,
  `survey.md` to hear the "voice" the product gives agents
- `packages/conductor` tick/reconcile — how work actually advances
- `packages/api` routes — what the human can actually see/do
- Test fixtures — what a "well-formed ticket" looks like end to end

## Answer these questions (evidence-backed, quote file:line)

1. **Mission** — in one sentence: what does this product exist to do?
   Then the honest version: is it "AI writes code" or "humans write
   specs and AI fills in the rest"? Where does the repo's own weight
   sit (spec machinery vs codegen)?
2. **User** — who is the primary user (solo engineer? tech lead?
   team)? What evidence: actor model, shared queue, workspace model.
3. **The wedge** — what does this do that Devin/aider/Copilot alone
   don't? Name the 2–3 mechanisms that are genuinely differentiating
   (spec lint? deviation metrics? gate_items as attention queue?) and
   which are commodity.
4. **The loop** — trace a ticket end to end through the state machine.
   Where does the human touch it, and is that intentional design or
   accidental friction? Does the "inbox" organizing principle hold up?
5. **Tension report** — where do docs and code disagree? What's
   promised but thin (jira importers? daemon mode? voice?)? What does
   TRACKER's cut/deferred history reveal about real priorities?
6. **Business shape** — implied pricing model, moat, and the metric
   the founders would put on the homepage (deviation rate?
   cost-per-merge? spec-score trend?). Is "spec quality" a feature or
   the whole product?

## Rules

- **Docs are claims; code is evidence.** When they disagree, code wins
  and you say so explicitly.
- **No marketing voice.** Write like a PM doing a diligence pass for an
  acquirer — respectfully skeptical.
- Name the **biggest product risk** and the **biggest positioning
  risk** — e.g. is this a feature of the coding agents it orchestrates?
- Keep opinions labeled as opinions; keep facts cited.

## Write `docs/PRODUCT-MISSION.md` in this shape

```
# Product mission — sprint-runner
Date, reviewer, scope

## The one-liner            — mission statement, plus the honest version
## Who it's for             — user, team size, context of use
## The daily loop           — what a user's Tuesday looks like
## The wedge                — 2-3 differentiators, each with evidence
## What it is NOT           — explicit non-goals found in docs/code
## Claims vs reality        — table: doc claim · code evidence · verdict
## Mission risks            — product risk, positioning risk, adoption risk
## Open questions           — what the docs can't answer; ask the founder
## Recommendation           — 3 bullets: sharpen / cut / double-down on
```
