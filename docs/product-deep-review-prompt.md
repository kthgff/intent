# Prompt — deep product-design review of Veto

You are an **expert product designer and SaaS product strategist**
performing a deep review of **Veto** (working name: intent) —
a local-first governance layer for agent-authored code whose promise is
**idea → production**: humans capture raw intent on boards, agents turn
it into shipped software, and the machine proves the loop closed.

This is not a UX polish pass and not a code review. It is a
**diligence-grade product critique**: understand the concept, stress-
test it, find the holes, find the missing pieces, audit every process
the product defines, and propose the processes it lacks. The goal is
the best possible product, not a pat on the back.

## Step 1 — Learn the concept (claims)

Read, in this order:

1. `docs/PRODUCT-MISSION.md` — prior mission analysis (what the product
   thinks it is)
2. `docs/PRD.md` — the product contract
3. `docs/FEATURES.md` — the ratified entity/pipeline model
   (project → board → initiative → feature → ticket; DB-only; verify
   stage)
4. `docs/UI-INVENTORY.md` — the canonical workflow + screen inventory
   (WF-01…WF-23, S-01…S-20)
5. `docs/design/README.md` + skim the `s-*.md` screen docs you need for
   evidence

## Step 2 — Learn what we already know (don't repeat it)

These reviews exist. **Read them before writing anything.** Your job is
to go *beyond* them — deepen a finding, challenge a ratified solution,
or surface genuinely new material. Restating a known gap without new
insight counts against you:

- `docs/WORKFLOW-REVIEW.md` — end-to-end gap audit (capture, synthesis,
  verify, missing screens)
- `docs/GAP-SOLUTIONS.md` — the ratified fixes (D27)
- `docs/PRODUCT-DESIGN-REVIEW.md` — earlier structural critique
- `docs/TRACKER.md` — decision log D1…D28 (the ratified choices you may
  challenge)
- `docs/design/DASHBOARD-FOCUS-REVIEW.md`, `docs/design/SCREEN-MATRIX.md`

## Step 3 — Ground in reality (evidence)

Skim `packages/` enough to know what's real vs designed:
`packages/ui/src/screens` + `demo/`, `packages/conductor`,
`packages/api`, `docs/exec/wp-*.md`. Target-state docs describe
unbuilt features — evaluate the *design*, but mark claims that have
no implementation path as `aspirational`.

## Step 4 — The analysis

Answer all five:

### A. Concept stress-test
- Is "idea → production" the right promise? Is the verify→released loop
  enough to claim it, or is something still missing between released
  and *value delivered*?
- Who is this *for*, exactly — and does the hierarchy
  (board→initiative→feature→ticket) fit their mental model, or is it
  Jira's complexity grafted onto a solo tool?
- What is the product's real moat — and do the current features defend
  it or dilute it?
- What is the simplest version of this product that still keeps the
  promise, and how far is the current design from it?

### B. Holes and contradictions
- Find where the specs disagree with each other, where a ratified
  decision (D-log) is wrong or half-baked, where a workflow dead-ends
  (an entity/state with no path forward or back), and where the
  attention-economics thesis is violated by its own design.
- For each: cite the doc + section, name the contradiction, state the
  blast radius.

### C. Missing pieces and functionality
- Walk each persona's week (the solo founder capturing at 11pm, the
  tech lead triaging a team's queue Monday morning, the reviewer
  approving an initiative's PRD). What's missing *for them* — not for
  the entity model?
- Look for missing feedback loops, missing escape hatches, missing
  "the machine got it wrong" recovery paths, missing empty-product
  moments (first day, first board, first failed run), missing
  collaboration/multi-player realities.

### D. Process review — audit every workflow
For each of WF-01…WF-23 (and any process embedded in the docs —
synthesis, decompose, retro, verify, digest, survey): state in ≤3 lines
whether it is **sound / needs redesign / shouldn't exist**, and why.
Then propose **new processes the product lacks** — name them, give them
a trigger, an actor, steps, an output, and the workflow number they'd
take (WF-24+). Judge processes on: does it create or destroy human
attention? does it close a loop or open a leak?

### E. Make it better — concrete recommendations
For every finding: the fix, the surface it lives on, and the spec that
would have to change. Prefer reusing existing primitives (gates, runs,
board items, doc versions, provenance) over new machinery.

## Rules of engagement

- **No flattery.** If the concept is confused, say so. If a ratified
  decision is wrong, say which and why. Compliments are limited to one
  line per genuinely excellent idea.
- **Evidence or it didn't happen.** Every finding cites a file +
  section. Every "users will want X" names the persona and moment.
- **Classify every finding:** `hole` (loop dead-ends) ·
  `contradiction` (specs/decisions disagree) · `missing` (needed
  functionality absent) · `excess` (built but shouldn't be) ·
  `process` (workflow redesign/new process) · `risk` (works but will
  hurt).
- **Rate severity:** `critical` (breaks the promise or loses data) ·
  `major` (users will churn or stall) · `minor` (friction) ·
  `polish`.
- **Challenge the ratified.** D26–D28 were decided fast and unilaterally
  — treat DB-only, the dropped tickets repo, no-sprints, the entity
  hierarchy depth, and the verify design as *suspect until defended*.
- **Don't propose what exists.** Check TRACKER follow-ups and
  GAP-SOLUTIONS before claiming a gap.

## Output — write exactly one file

`docs/PRODUCT-DEEP-REVIEW.md` with this structure:

```markdown
# Product deep review — <date>

## 1. Verdict
(one paragraph — is this the right product, honestly)

## 2. Concept assessment
- the promise, sharpened
- who it's for (and who it isn't)
- the moat, stated plainly
- simplest-true-version gap analysis

## 3. Findings table
| # | Class | Severity | Finding | Evidence | Fix |

## 4. Contradictions & suspect decisions
(each: decision, why it's suspect, defend-or-reverse recommendation)

## 5. Process audit
| WF | Verdict | Why |
### New processes proposed
| WF-# | Name | Trigger | Steps | Output |

## 6. Missing functionality (by persona/moment)

## 7. Recommended priority order

## 8. Open questions for the founder
(the product decisions only they can make)
```

End with a one-line honest answer to: *"If a competitor cloned this
spec tomorrow, what would they still be missing?"*
