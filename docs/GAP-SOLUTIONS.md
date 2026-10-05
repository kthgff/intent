# Gap solutions — filling the idea→production loop

Companion to `WORKFLOW-REVIEW.md` (2026-10-04). For each finding:
the product decision + the UX shape. **Ratified as target-state decisions in
D27**; implementation and lower-level API/schema migration remain pending.

---

## G1. Post-merge verify — make "production" real

**Decision:** insert a `verify` stage between merged and terminal.

- New statuses: `merged → verifying → released` (terminal) and
  `verify_failed` (routes to S-10). `merged` stops being a leaf.
- The check, in order of preference:
  1. `verify_cmd` on the initiative/project (a script — health check,
     smoke suite) — run by the conductor post-merge;
  2. else `app_url` smoke — Playwright crawler (already built for
     survey) loads the app, screenshots, checks for render/console
     errors;
  3. else human gate — `verify-confirm` gate item lands in inbox:
     "FE-3 merged everywhere — confirm it works" (one click).
- Board item `shipped` now requires `released`, not `merged` — the
  honest signal. Idea→merge lead time stays as the pipeline metric;
  add **idea→released** as the marketing number.
- Board column: `verifying` renders in Review (it's post-merge
  scrutiny); `released` joins Done.

**UX:** S-05 gets a Verify next-action state (`verifying` = run card;
`verify_failed` = failure panel; manual confirm = one-click gate).
Feature/initiative rollups show a `verified` badge. Cheap v1: manual
gate only — automated smoke is v1.1.

---

## G2. S-18 Initiative detail — give the largest entity a home

S-05/S-17 anatomy, adapted: the initiative is upstream of execution,
so its workbench is **spec + tree**, not runs.

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Board   IN-7 — Billing overhaul      [Spec · feature-decompose]  │
│           myApp · board:Q1-goals · P1 · 14 items consumed   [Ledger]│
│ ┌───────────────────────────────────────────────┐ ┌──────────────┐ │
│ │ NEXT ACTION — waiting on you · split plan     │ │ STATUS       │ │
│ │ 5 features proposed — review coverage         │ │ Spec'ing     │ │
│ │ [Review plan →]                               │ │ Waiting you  │ │
│ ├───────────────────────────────────────────────┤ ├──────────────┤ │
│ │[Overview][Docs][Features][Provenance][Activity][Runs]            │ │
│ │                                               │ │ WHAT'S LEFT  │ │
│ │  rendered prd.md summary / selected surface   │ │ ✓ Board syn  │ │
│ │                                               │ │ ✓ PRD+TDD    │ │
│ │                                               │ │ ● Features   │ │
│ │                                               │ │ ○ Tickets    │ │
│ │                                               │ │ ○ Delivered  │ │
│ └───────────────────────────────────────────────┘ ├──────────────┤ │
│                                                   │ KEY FACTS    │ │
│                                                   │ $ spent · items│ │
│                                                   └──────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

- **Features tab** — rollup table: feature, status, tickets n/m, open
  gates, cost. Row → S-17. This is the "project view" inside one
  initiative.
- **Provenance tab** — two-pane browser (see G8).
- **Overview** — goal one-liner, rendered PRD summary, board link
  (opens S-16 filtered to consumed items), metrics.
- **Header actions** — `Re-plan` (G6), `Discard` (G3), `Verify` when
  delivered, priority + owner fields.
- What's-left roadmap: `Synthesized → Spec approved → Features →
  Tickets → Delivered`. Same derivation pattern as S-05.

Wireframes/spec → `docs/design/s-18-initiative-detail.md` (new doc);
UI-INVENTORY S-18 row: "A spec container (S-05 anatomy): docs tab,
feature rollup, provenance browser, re-plan/discard."

---

## G3. Undo synthesis — `unconsume`

**Decision:** initiatives get a `discarded` terminal status; discarding
releases its consumed items.

- `Discard initiative` (S-18 header, confirm modal: "N consumed items
  return to the board; PRD+features are archived — nothing is deleted,
  events record why") → children get `wont_do`, consumed items return
  `open` with a `was: consumed→IN-7` ghost tag (visible history, not
  pretend-nothing-happened).
- Provenance is *deleted* (it never shipped), the `initiative_discarded`
  event records the correction. Frozen-history rule preserved: the
  event log is the audit, not the item state.
- Partial discard: unlink individual items via provenance editor (G8)
  without killing the initiative.

---

## G4. Scoped synthesis — zone / selection / incremental

**Decision:** `board-synthesize` takes a `scope` param; the Synthesize
button becomes a split button.

```
[ Synthesize ▾ ]   default: "New items since last run (5)"
   · Entire board (23 open)
   · Zone: onboarding (6)
   · Selection (3 selected)      ← enabled when marquee >0
   · New since last run (5)
```

- Marquee-selected items → right-click → `Synthesize selection`.
- Zone scope uses zone bounds — topology already serialized.
- Incremental ("new since last run") becomes the *default* for boards
  that already spawned initiatives — matches the "one board, many
  PRDs" model without re-reading consumed items.
- Icebox stays excluded everywhere.

---

## G5. Capture tray — the zero-friction front door

**Decision:** a project-scoped **tray** holding untriaged captures;
feeds any board.

- **Ingress:** CLI `veto add "thought"`, desktop global hotkey
  (`⌘⇧C` → quick-capture modal — title + type + board-or-tray),
  `⌘K` → `capture`, email/webhook endpoint (`POST /capture`), and a
  minimal mobile web route `/capture` (single field — no canvas).
- **Tray storage:** `board_items` rows with `board: null` + tray
  status — no schema invention.
- **Surfaces:**
  - Sidebar tray icon + count (like a mail inbox for ideas).
  - S-16 gains a **tray dock** — collapsible bottom strip; drag items
    up onto the canvas, or leave them: synthesis offers "include tray
    (n)" as a scope option.
  - `⌘K capture` modal: text field + type chip-guess + "place on:
    Q1 goals ▾ / tray" — three keystrokes total.
- Auto-type guess on ingest (question mark → `question`, imperative →
  `requirement`), user can fix later — capture must never ask more
  than "what's the thought."

---

## G6. Manual entity creation + re-plan — non-board paths

**Decision:** two new affordances.

- **New initiative/feature** — `+` in sidebar Boards section → menu:
  `New board · New initiative · New feature`. Blank initiative lands
  `prd-draft` via a short interview (or paste-your-own doc). Feature
  creation requires choosing a parent initiative (or explicitly
  "orphan").
- **Re-plan** — header action on S-17/S-18 once children exist:
  "scope changed? re-run decompose against unmet ACs." Run takes
  `replan: true` + optional human note ("drop the billing UI work").
  Output = split-plan **v2 diff** in S-06 (added/removed/changed
  children highlighted); already-`released`/`merged` children are
  locked rows in the table.
- **Re-parent** — `Move…` action on ticket/feature headers: pick a
  new parent; emits `reparented` event; provenance links follow.

---

## G7. Question budget — cap + overflow

**Decision:** `synthesize.max_questions: 15` (config, matches the
stated intent). When the run wants more:

- questions ranked by blocking-value; top 15 asked;
- remainder become an `## Open questions` section in the drafted PRD —
  a gate item surfaces them later, answerable at leisure;
- wizard footer shows the cap honestly: "9 of 15 · most important
  first."

---

## G8. Provenance editing — correctable, still honest

**Decision:** provenance is human-editable via **amendment events** —
never silent mutation.

- S-18 Provenance tab: two panes — left = AC/requirement list, right =
  board items (consumed dimmed). Drag item onto an AC → link; ✕ on a
  chip → unlink. Each edit writes a `provenance_amended` event
  (`{ac, item, op: link|unlink, actor}`) — the audit trail records the
  correction itself.
- Same editor embedded in S-06 as an "edit links" mode while the PRD
  is still in review.
- Everything downstream (delta views, shipped tracking, lead-time)
  reads current provenance; the event log shows its history.

---

## G9. Attention above the ticket level — owner + priority + digest

- **Priority** on initiative + feature (P0–P3, same chip vocab);
  inbox grouping orders initiatives by it; board cards show it;
  default = inherit from parent.
- **Owner** — optional `owner` field on initiative/feature/ticket
  (avatar chip in headers; "assigned to me" inbox filter). Solos
  ignore it; teams get accountability without Jira ceremony.
- **Stale-idea resurfacing** — `boards.digest: weekly|off` + item
  `touched_at`. Surfaces: a `Digest` gate kind ("14 items untouched
  60d on Q1 goals — synthesize / icebox / keep?") and a stale-count
  badge on S-15 board cards. Also: **retro-on-close** — retro cards
  fire on initiative `closed`/`discarded`, not only `delivered`
  (partial failure is when the retro matters most).
- **Cost preview** — Synthesize confirm shows an estimate
  (`~14 items ≈ $2–4 on sonnet`) derived from serialized size × model
  price; actual lands post-run. Same pattern on re-plan.

---

## G10. Synthesis context — feed the machine its own intelligence

**Decision:** `board-synthesize` extract gains three sources:

1. **Dossier digest** — `context_file` + key S-14 sections
   (architecture map, landmines, personas), token-budgeted
   (`synthesize.context_tokens`, default ~8k).
2. **Prior-art recall** — semantic match of items against existing
   initiatives/features/tickets (`prior_art_recall`, `semantic.*`
   already in config) → overlap list injected into the Q&A step:
   "sticky 'SSO' overlaps FE-2 'auth' — extend or new?" That answer
   becomes a provenance/decomposition hint.
3. **Open-question memory** — prior `Open questions` sections from
   sibling initiatives on the same board.

Net effect: brownfield-aware PRDs + conflict surfacing *before* review
instead of during.

---

## G11. Ship-list features — small, high-value

- **Release notes** — on initiative `delivered`, a run generates
  `release-notes.md` (features shipped, ACs met, PR links, cost,
  lead time) → attached to S-18 + optional `gh release`. The ledger
  already has every fact.
- **Feedback ingestion** — `feedback` item type: `POST /capture` with
  `kind: feedback` + optional `ref` (initiative/feature). Sentry/user-
  report webhooks later; manual "log feedback on IN-7" now. Shipped
  entities get a feedback count in their headers.
- **Global search** — `⌘K` extends to board items + doc full-text
  (Postgres FTS — `tsvector`/`tsquery` over `board_items.content` +
  `doc_versions`), results grouped by entity kind.
- **Seeded onboarding board** — first-run creates a "Getting started"
  board pre-loaded with 6 example items + a guided sticky ("press
  Synthesize — watch this become a PRD"); board templates
  (`blank | prd-prep | retro | research`) in the new-board form.
- **Cancel cascade** — `wont_do` on initiative/feature → modal:
  children handling (`wont_do` / keep / re-parent) + consumed-item
  handling (release vs keep-consumed). No silent cascades.
- **Cross-entity deps** — `depends_on` on feature rows (not just
  split children); board card + S-17 show a `blocked by FE-7` chip.
- **Optional UAT gate** — `gates.uat: on|off` (default off): when on,
  released→`released` requires the `verify-confirm` gate even if the
  smoke check passed — for teams that hand-test.
- **Ratified omission** — no sprints/dates/velocity. Record as a
  D-log decision: attention-budget, not cadence management. Optional
  free-text `target` on initiative later if demand appears.

## Priority order (proposed)

| # | Item | Why first |
| --- | --- | --- |
| 1 | Verify stage (G1) | makes the product claim true; cheap v1 = manual gate |
| 2 | S-18 initiative detail (G2, G8, G6) | the hub that hosts provenance editing + re-plan + discard |
| 3 | Unconsume + scoped synthesis (G3, G4) | correctness — users will corrupt boards without it |
| 4 | Capture tray (G5) | front door of the funnel |
| 5 | Dossier + prior-art in extract (G10) | spec quality = the differentiator |
| 6 | Question budget (G7) + cost preview (G9) | attention/spend honesty |
| 7 | Release notes + feedback + search + templates (G11) | polish that compounds |
