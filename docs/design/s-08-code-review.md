# S-08 — Code review page

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: the centerpiece — where a human approves generated code
(WF-06). Everything the reviewer needs is pre-digested in a header
brief; the Changes and Issues tabs carry the actual diff and the
agent's own findings.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K                                                     │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │ ← SR-0142  Session cache            review · round 2  [1]   │
│  SIDEBAR   │ ─────────────────────────────────────────────────────────── │
│            │  BRIEF                                                    │ │
│  Inbox   9 │  +412 −87 · 9 files · backend,web                       [2] │
│  Tickets   │  AC: ac1✓ ac2✓ ac3✓ · spec-compliant: yes (2 addenda)     │ │
│  Review  2 │  tests: 16/17 pass (c4 skip — needs staging)  report →    │ │
│  Queue   1 │  risks: session-fixation edge · tech-debt: 1 note         │ │
│  Escal.  2 │  TDD addenda (2): used LISTEN/NOTIFY not polling — why ▸  │ │
│  Metrics   │  commits: 4  ──●──●──●──●──  story ▸                      │ │
│  KB        │ ─────────────────────────────────────────────────────────── │
│            │  [Changes] [Issues 5] [Test panel]                   [3]    │
│            │  ┌─────────┬────────────────────────────────────────┐      │
│            │  │ FILES   │  store.go                        [4]   │      │
│            │  │ ▾ internal│  @@ -40,12 +40,18 @@                 │      │
│            │  │  session/ │  -  rows := q.Fetch(ctx)             │      │
│            │  │  store.go │  +  rows, err := c.cache.Get(ctx)    │      │
│            │  │  cache.go │  +  if err != nil { … }       💬1    │      │
│            │  │  +98 −12  │                                     │      │
│            │  └─────────┴────────────────────────────────────────┘      │
│            │  ────────────────────────────────────────────────────────── │
│            │  5 open findings · 2 blocker      [Send back] [Approve →]  │
│            │                                                       [5]  │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Header** — ticket ref, review round, link to S-05.
2. **Brief strip** — the reviewer's TL;DR, all glanceable:
   diffstat · files · repos · **AC traceability** (each ac_id ✓/✗ with
   where-satisfied popover) · spec-compliance verdict · **TDD addenda**
   count (deviations the implementer recorded — expandable table:
   planned/did/reason) · risk register · tech-debt notes · highlights ·
   commit-story mini-timeline · test-report summary.
3. **Tabs** — Changes | Issues (open count) | Test panel.
4. **Changes** — left file tree w/ per-file diffstat; side-by-side diff;
   inline comment threads on lines (same anchored-thread component as
   S-06). Findings anchor to their `file:line` too.
5. **Footer decision bar** — open-finding rollup by severity +
   **Send back** (→ fix round / `changes-requested`) and
   **Approve → merge** (opens PR flow per merge_strategy). Approve is
   disabled while blocker/major findings are `open`.

## Issues tab

```
│ ☐ f-8f3a  BLOCKER  correctness · code-bug        store.go:44   │
│    nil-deref on cache miss — Get returns (nil,nil)             │
│    evidence ▸   suggested fix ▸   confidence 0.9   round 1,2   │
│    [Send to fix] [Dismiss] [Wontfix] [Reply…]       thread ▸   │
```

- **Finding card** — `thread_id`, severity chip (blocker red / major
  orange / minor amber / nit gray / question blue), category,
  `kind` badge (**spec-bug** violet / **code-bug** slate — the
  spec-quality signal), file:line deep-link into Changes, body,
  collapsible evidence + suggested_fix, confidence, `rounds_seen`
  chips, `replies` thread.
- **Verdicts** — **send to fix** (queues the finding as fix-run
  input; status stays `open` until `finding_fixed`), **dismiss**
  (feeds `fix_dismissal_cap` logic), **wontfix**, **reply** — labels
  map onto SCHEMAS §6 statuses `open|fixed|dismissed|wontfix`; there
  is no "accepted" status.
- **Batch-fix** — checkbox column + "send N to fix" bar.
- Group by severity; filter by category/kind/status/round.

## Test panel

Ground truth from `test-report.json`: pass_pct donut, per-case rows
(`case_id`, file, implemented, result pass/fail/skip — skips show
`risks` note), DoD `verified_by` checklist (`cmd:` rows show
run-result, `manual` rows show an attest checkbox — merge blocked
until all green).

## Interactions

- `⌘1/⌘2/⌘3` tabs, `j/k` findings, `f/d/w` verdicts (fix/dismiss/
  wontfix), `Enter` open diff.
- Approve confirm shows strategy (`squash`) + per-repo PR preview
  (multi-repo tickets approve all `ticket_repos` rows at once).
- `changes-requested` loops surface back here each round — round
  indicator + "what changed since round 1" diff-range toggle.

## Style notes

- Diff: side-by-side ≥1400px, unified below; syntax-highlighted,
  zinc-950 bg, subtle red/green line fills.
- Finding cards left-border colored by severity.
- Brief strip: zinc-900 card, stat-pair layout, mono numbers.
