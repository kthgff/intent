# S-18 — Initiative detail

Design doc companion to `UI-INVENTORY.md` §2 + `FEATURES.md` §1/§8.
Status: draft 2026-10-04 (D27). Stack: React+Vite · Tailwind ·
shadcn/ui (Radix). Style: Linear-inspired — dual-theme (dark + light, D34), dense, minimal
chrome. Anatomy: deliberate S-05/S-17 clone — an initiative is the
spec container upstream of execution; same operational-hub layout,
spec+tree flavored instead of run flavored.

Purpose: everything about one initiative — the container born of a
board synthesis that owns the PRD+TDD the whole tree inherits (WF-18…
WF-22 hub). Tracks its features, owns its provenance, carries its
gates, and hosts the re-plan/discard/verify actions.

## Layout

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ← Board   IN-7 — Billing overhaul         [Spec · feature-decompose]  │
│           myApp · board:Q1-goals · P1 · K · 14 items consumed  [Ledger]│
│ ┌──────────────────────────────────────────────┐ ┌───────────────────┐│
│ │ NEXT ACTION — waiting on you · split plan    │ │ STATUS            ││
│ │ 5 features proposed — coverage map ready     │ │ Spec'ing          ││
│ │ [Review plan →]                              │ │ Waiting on you    ││
│ ├──────────────────────────────────────────────┤ ├───────────────────┤│
│ │[Overview][Docs][Features][Provenance][Activity][Runs]             ││
│ │                                              │ │ WHAT'S LEFT       ││
│ │  selected work surface                       │ │ ✓ Synthesized     ││
│ │                                              │ │ ● Spec approved   ││
│ │                                              │ │ ○ Features        ││
│ │                                              │ │ ○ Tickets         ││
│ │                                              │ │ ○ Delivered       ││
│ └──────────────────────────────────────────────┘ ├───────────────────┤│
│                                                  │ KEY FACTS         ││
│                                                  │ $2.40 · 14 items  ││
│                                                  │ spec ◐71          ││
│                                                  └───────────────────┘│
└───────────────────────────────────────────────────────────────────────┘
```

Two-column operational hub — wide workbench + narrow status rail —
same as S-05-ticket-focus. No permanent AI rail; AI appears in
contextual doc editing via `/interview` (`subject_ref: IN-7`).

## Annotations

1. **Header** — back link (to the board), `IN-x` identity + title,
   status badge (phase + sub-status), project, **board link**
   (`board:Q1-goals` → S-16 filtered to this initiative's consumed
   items), priority chip, owner avatar, items-consumed count,
   `[Re-plan]` `[Move…]` `[Discard]` menu, ledger link.
2. **Next action** — same component as S-05: current gate (doc
   approval, split plan, synthesis Q&A), active run card, or terminal
   outcome (`delivered` shows release notes + retro card link;
   `discarded` shows released-items summary).
3. **Workbench tabs:**
   - **Overview** — goal one-liner, rendered PRD summary, board
     thumbnail/provenance link, headline metrics (cost so far, spec
     score rollup, lead-time clock since first consumed item).
   - **Docs** — `prd.md` + `tdd.md`, versioned, S-06 reviewer embedded
     with the **trust-inheritance delta view** and `grounded in N
     items` provenance badge. `Revise with Veto` composer
     (`subject_ref` edit mode, dir-scoped diffs).
   - **Features** — rollup table: feature, status chip, tickets n/m,
     open gates, cost, `blocked by` chips; row → S-17. "+ New feature"
     creates a manual child (blank → `feature-draft`).
   - **Provenance** — two-pane editor (below).
   - **Activity** — S-11 ledger scoped to the initiative and all
     descendants.
   - **Runs** — synthesis/decompose/retro runs for this subject.
4. **Status rail** — current phase + next-step sentence + vertical
   roadmap: `Synthesized → Spec approved → Features → Tickets →
   Delivered`. Derived from server status; not an editor.
5. **Key facts** — spend to date, consumed-item count, rolled-up
   `spec_score`, board, created, owner.

## Provenance tab (the unique surface)

```text
│ ACCEPTANCE CRITERIA                │ BOARD ITEMS                     │
│ ac1 SSO optional           🟨🟨📄  │ 🟨 "SSO must be optional" ← ac1 │
│ ac2 99.9% uptime           🟩🔗   │ 🟨 "users skip step 3"    ← ac4 │
│ ac3 —no items— ⚠ ungrounded       │ 📄 RFC — new pricing    ← ac1   │
│                                    │ 🟨 "offline mode?"  unlinked   │
│  drag item → AC to link · ✕ unlink │ consumed dimmed · tray section │
```

- Left: every `ac_id`/`req` from the PRD, chips showing linked items;
  `⚠ ungrounded` highlights ACs with no backing item (synthesis gap
  the human should close or own).
- Right: the board's items (consumed shown dimmed) + tray items;
  drag onto an AC to link, ✕ to unlink.
- Each edit writes `provenance_amended {ac, item, op: link|unlink,
  actor}` — append-only; the amendment history shows under each AC.
- Downstream readers (delta views, shipped tracking, lead-time) use
  current provenance; the event log preserves its history.

## Status enum

triage → prd-draft → prd-review → prd-approved → tdd stages →
`feature-decompose` → `implementing` → `delivered` | `closed` |
`discarded`. `discarded` (via Discard action) releases consumed items
to `open` w/ `was: consumed→IN-x` ghost tag, children get explicit
cascade choices (wont-do/keep/re-parent) — never silent.

## Fields

| Surface | Source |
| --- | --- |
| Header/status/roadmap | `initiatives` row + derived phase |
| Next action | open `gate_item` (initiative-doc-review, split-plan, verify-confirm) or active run |
| Docs | `doc_versions` (subject = initiative) |
| Features | `features` rollup + `tickets` counts + `usage_calls` cost |
| Provenance | `provenance jsonb` + `board_items` + amendment events |
| Activity | `events` where subject = initiative or descendants |

## Interactions

- `Re-plan` → confirm ("re-plan unmet ACs — 3 of 8 features
  delivered and locked") → `initiative-decompose` run w/ `replan:
  true` → S-06 split-plan v2 diff.
- `Discard` → cascade modal (children handling + consumed-item
  release choices) → `initiative_discarded` event.
- All actions keyboard reachable; SSE updates don't steal focus or
  reset the tab (shared baseline).

## Style notes

- Same dual-theme (dark + light, D34) zinc palette; `IN-` ids in JetBrains Mono.
- Features table rows 32px, status chips reuse pipeline vocabulary.
- Provenance pane: dimmed = consumed, outline-dashed = unlinked,
  `⚠` amber = ungrounded AC.
