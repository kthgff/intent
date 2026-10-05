# S-12 — Metrics dashboard

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: ROI proof (WF-14) — is the machine worth it, and is the SPEC
the thing to fix. Aggregates from `events_idx`/`usage_calls`
(`/metrics` endpoint). All numbers honest: estimated usage flagged,
nulls shown as `—`, never synthesized.

**Revised (D26):** the headline metric becomes **idea→merge lead time**
(sticky/idea → merged code, via `provenance.json` links — the number no
competitor can print). Scope filter is project; panels add board/initiative
aggregates.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K      [All projects ▾]  [30d ▾]      🔔3  ⚙   [1]  │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  Metrics                                                     │
│  SIDEBAR   │  ────────────────────────────────────────────────────────── │
│            │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       [2] │
│  Inbox   9 │  │ 71%     │ │ $4.20   │ │ 18 min  │ │ 2.3     │           │
│  Tickets   │  │ →merged │ │ /merge  │ │ human/tkt│ │ fix rnds│           │
│  Review  2 │  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│  Queue   1 │                                                             │
│  Escal.  2 │  FUNNEL                        TOKENS / TICKET         [3]   │
│  Metrics   │  ┌───────────────────────┐   ┌───────────────────────┐      │
│  KB        │  │ imported     ████████ │   │ triage   ▏12k/3k      │      │
│            │  │ specced      ██████   │   │ prd      ▏31k/8k      │      │
│            │  │ implemented  █████    │   │ tdd      ▏22k/6k      │      │
│            │  │ merged       ████ 71% │   │ impl     ▏96k/21k ~est│      │
│            │  └───────────────────────┘   │ review   ▏44k/9k      │      │
│            │   dies at: needs-info 3,     └───────────────────────┘      │
│            │            review-fix 2            per-model table ▸ [4]   │
│            │                                                             │
│  SPEC QUALITY — is the spec the bug?                              [5]    │
│  ┌─────────────────────────┐  ┌─────────────────────────┐               │
│  │ Deviation rate   0.8/tkt│  │ spec-bug  ████░░ 40%    │               │
│  │  missing-file 3,        │  │ code-bug  ██████ 60%    │               │
│  │  spec-ambiguous 5 ←     │  │ spec-score trend ↗ 62→78│               │
│  └─────────────────────────┘  └─────────────────────────┘               │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Scope controls** — project filter + time range (7d/30d/90d/all).
2. **KPI cards** — headline numbers: tickets→merged rate, cost-per-
   merge, human-minutes/ticket (from `human_minutes` / gate dwell),
   avg fix rounds — plus **idea→merge lead time** (median board-item→
   merge via provenance) and **board yield** (% board items that reach
   shipped/delivered vs iceboxed/dead).
3. **Stage funnel + token column** — funnel shows where tickets die
   (count per exit stage under it); tokens table per stage in/out/
   cached with `~est` flags — dollars sit beside, never replace,
   tokens (per SCHEMAS honesty rules).
4. **Per-model table** — expandable: model × stage → runs, success
   rate, tokens, cost, fix rounds.
5. **Spec-quality panel** — the differentiator: **deviation rate**
   (headline) decomposed by `reason_kind` (missing-file, wrong-api,
   spec-ambiguous, upstream-change, perf, other); spec-bug vs code-bug
   finding mix; spec-score trend line over time.

## Panels

| Panel | Data |
| --- | --- |
| KPIs | `tickets` + `events_idx` aggregates |
| Idea→merge lead time | board item `created_at` → descendant ticket `merged` event (`provenance.json`) |
| Cost per feature | `usage_calls` rolled up through feature/initiative lineage |
| Board yield | board items by lifecycle state (open/consumed/shipped/icebox) |
| Funnel | status transitions per ticket (+ initiative/feature rollup) |
| Tokens/stage | `usage_calls` grouped by stage, `usage_source` flags |
| Per-model | `usage_calls` × `runs.model` |
| Deviation | `DEVIATIONS.md` reason_kind events |
| Finding mix | `review.json` `kind` rollup |
| Human minutes | `gate_items` dwell + `human_minutes` events |

## Interactions

- Every number drills to the underlying ticket list (click → filtered
  S-05 list).
- Charts: simple bars/sparklines — no heavy chart lib needed at v1;
  keep to `recharts` or hand-rolled SVG (decide in wp).
- Empty state: "run a few tickets — metrics appear after first merge."

## Style notes

- KPI cards: 4-up zinc-900 tiles, 28px mono number, 11px label.
- Bars: single accent color, `~est` values get hatched/amber styling —
  estimated data must look different at a glance.
- Grid: 2-col ≥1200px, 1-col below.
