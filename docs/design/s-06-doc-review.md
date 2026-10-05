# S-06 — Doc review page

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: human review of agent-drafted markdown — PRD, TDD, test plan
(WF-04), plus the split-plan variant (WF-15). One doc-review component
serves all: rendered markdown + paragraph-anchored comments + version
diff + approve / request-changes.

**Revised (D26):** the same component reviews initiative docs
(`prd.md`/`tdd.md` at initiative scope) and feature docs
(`feature.md`, `test.md`). Two additions: a **provenance badge** on
initiative docs (`grounded in 14 board items` → opens `provenance.json`
viewer / back to S-16), and a **trust-inheritance delta view** — under
`plan-package` mode, child tickets inherit the approved initiative spec;
the delta view shows only what a child adds/changes vs the inherited
baseline, so reviews stay cheap.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K                                                     │
├────────────┬──────────────────────────────────────────────┬──────────────┤
│            │ ← SR-0142 · PRD — v3               [v3 ▾][1]  │              │
│  SIDEBAR   │ [Rendered][Diff v2→v3][Coverage]        [2]   │   DECISION   │
│            │ ───────────────────────────────────────────   │ ┌──────────┐ │
│  Inbox   9 │                                              │ │ AC map   │ │
│  Tickets   │  # PRD — SR-0142: Session cache        [3]  │ │ ac1 ✓ c2 │ │
│  Review  2 │                                              │ │ ac2 ✓ c5 │ │
│  Queue   1 │  ## Problem / why                            │ │ ac3 ⚠ —— │ │
│  Escal.  2 │  Session lookups hit Postgres on every  💬2  │ │          │ │
│  Metrics   │  request — 40ms p50 overhead…                │ │[Approve ]│ │
│  KB        │ ┌────────────────────────────────────────┐   │ │[Request  │ │
│            │ │ 💬 K: "add the failover case"      reply │   │ │ changes] │ │
│            │ │ 💬 agent: "added §Req-4 — see diff"      │   │ │[Reject  ]│ │
│            │ └────────────────────────────────────────┘   │ └──────────┘ │
│            │                                              │      [6]     │
│            │  ## Requirements (final)                     │              │
│            │  | req | statement |                     💬+  │   THREADS 3  │
│            │                                              │ ──────────── │
│            │  ## Acceptance criteria                [4]   │ ▸ p1 add the │
│            │  | ac_id | criterion | verifies-how |        │ ▸ p4 cache   │
│            │                                              │   TTL?       │
└────────────┴──────────────────────────────────────────────┴──────────────┘
```

## Annotations

1. **Header** — ticket ref + doc kind + version picker (`v3 ▾` lists
   all versions; selecting an older one read-only).
2. **View switcher** — Rendered | Diff vs prior version | Coverage
   (coverage only for test.md — the coverage-matrix table rendered as
   a checklist: every `ac_id` / file-plan row → case_ids, unmapped
   highlighted red since lint can't pass with one).
3. **Doc body** — rendered markdown, tables rendered as tables.
   Every paragraph/row/section has a hover `💬+` gutter affordance;
   existing threads show a `💬n` badge and expand inline beneath
   the paragraph.
4. **Structured tables** (AC, file plan, coverage matrix, cases,
   DoD) render with pinned column headers exactly per SCHEMAS —
   the lint status of each row shown as a gutter tick/flag.
5. **Comment thread** — anchored to a paragraph; replies create a
   `doc_feedback` run → agent revises → new version lands and the
   thread shows the reply + diff link. Resolve per thread.
6. **Decision panel** — sticky right rail: AC/coverage mini-map,
   **Approve**, **Request changes** (requires ≥1 comment or a note),
   Reject. `plan-package` gates mode (the default — D26): all three docs
   stacked in one scroll with a single decision panel; **batch
   approvals** render a subjects list ("5 feature test plans — FE-2…FE-6")
   above one Approve-all action.

## Split-plan variant (WF-15)

The same table serves **all three decompose levels** (D26):
initiative → features (`initiative-decompose` run), feature → tickets
(`feature-decompose` run), and ticket → children (the original split).
Doc area replaced by the split table — read from `split-plan.md`:

| child | title | repos | depends_on | covers |
| --- | --- | --- | --- | --- |

- Rows editable (title/repos/boundary) before approval; a coverage
  map column shows parent ac_ids each child absorbs — unmapped ac_ids
  flagged red.
- Decision panel: **Approve split** (children materialize `imported`,
  parent → `split`) / **Reject** (back to triage) / edit-first.

## Fields

| Element | Source |
| --- | --- |
| Doc | rendered prd.md / tdd.md / test.md, `version` |
| Diff | line+paragraph diff vs selected prior version |
| Coverage | test.md Cases + Coverage matrix tables; lint status per row |
| Thread | author, body, ts, anchored paragraph ref, resolved |
| Decision | approve → `doc_approved`; feedback → `doc_feedback` run |

## Interactions

- `a` approve (confirm shows doc+version), `r` request changes,
  `d` toggle diff view.
- Approving a doc is a transactional `doc_versions` write + gate clear
  (D29 — in-app only; there is no mirror-PR channel).
- Threads left open on approve → warning ("2 unresolved threads —
  approve anyway?").

## Style notes

- Doc column 720px centered (prose measure); threads indent under
  their paragraph, not a side list (Linear comment UX) — side rail
  Threads list is just an index.
- Diff: red/green subtle fills, no side-by-side (markdown prose).
- Decision panel zinc-900 card, primary button indigo, destructive
  outline.
