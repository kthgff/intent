# Prompt — UI/UX self-evaluation of the sprint-runner screens

Use this prompt to have an agent critically evaluate the screen designs
and the running demo. Output: `docs/design/UX-EVAL.md`.

---

You are a senior product designer + front-end engineer doing a
**hostile-but-fair UX review** of the sprint-runner web UI — all 14
screens. Your job is to find what's wrong, not to validate what's right.

## Read first (in this order)

1. `docs/UI-INVENTORY.md` — the binding screen/workflow spec
2. `docs/design/README.md` — shared conventions, glyph + keyboard vocabulary
3. `docs/design/SCREEN-MATRIX.md` — routes, required states, known API gaps
4. All fourteen `docs/design/s-*.md` screen docs
5. `docs/PRD.md` §"attention budget" framing — the product's reason to exist

Then **use the running app** (demo mode, deterministic fixtures):

```
pnpm -F @sprint-runner/ui dev      # with VITE_DEMO_MODE=1
open http://localhost:5173
```

Visit every route from SCREEN-MATRIX. Take screenshots (Playwright via
`packages/ui/scripts/capture-demo.mjs` or the browser) when you cite a
visual problem.

## Evaluate on five axes

1. **Spec fidelity** — does the screen deliver every element its
   design doc promises? Flag anything spec'd but missing/invisible,
   and anything built that contradicts the spec.
2. **Attention economics** — the product's thesis is "human attention
   is the bottleneck." For each screen: can the user act in <10
   seconds? What's the ONE decision the screen exists for, and is it
   visually dominant? Flag every place chrome, decoration, or
   secondary data competes with the primary action.
3. **Information hierarchy & density** — glance order: what do you see
   in the first 3 seconds? Is the blocking-vs-human-step distinction
   (●/○) actually legible? Are densities honest — will 40 inbox items
   or a 10k-line transcript still work?
4. **Consistency** — do the screens share vocabulary? Check glyphs,
   chip styles, status colors, keyboard semantics, layout anatomy,
   empty/error states against README's baselines. Flag every screen
   that freelances.
5. **State coverage** — for each screen enumerate: loading, empty,
   error, partial/degraded (e.g. `~est` usage, missing artifacts),
   claimed-by-other, stale data. Which are designed vs assumed?

## Rules

- **Cite or it didn't happen.** Every finding needs evidence: screen,
   element, screenshot/route, and which doc it violates (or "design
   judgment" if no doc covers it).
- **Classify:** `spec-violation` · `usability` · `consistency` ·
   `state-gap` · `polish`. Severity: `blocker` / `high` / `medium` / `low`.
- **No cheerleading.** One line of "what works" per screen max. Spend
   the words on problems.
- **Propose, don't just point.** Every finding gets a concrete fix —
   field moved, control added, spec amended. If fixing it needs a spec
   change (AGENTS.md backport rule), say which doc.
- **Steel-man disagreements.** If you'd change a deliberate spec
   decision (e.g. blocking-first ranking), argue the counter-position
   honestly and label it `spec-question`, not a bug.
- Score each screen /10 with one-sentence justification; no 10s
   without saying what's missing.

## Write `docs/design/UX-EVAL.md` in this shape

```
# UX self-evaluation — 14 screens
Date, evaluator, scope (routes visited)

## Executive summary        — 5 lines max, top 3 cross-cutting problems
## Cross-cutting findings   — table: finding · screens affected · severity · fix
## Per-screen findings
### S-01 Inbox — score N/10
- [severity] finding → evidence → fix
…(all 14)
## Spec questions           — deliberate decisions worth revisiting
## Priority fix list        — ordered top-10 across everything
## Verification             — routes checked, screenshots taken, docs read
```

Finish with a **merge recommendation** for the demo pass:
`ship as-is` / `fix highs first` / `redesign these screens: <list>`.
```
