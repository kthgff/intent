# S-09 — PR status panel

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dual-theme (dark + light, D34), dense (13px base), minimal chrome.

Purpose: post-approve shepherding (WF-07) — one row per repo the
ticket touches: CI checks, teammate comments auto-fed to the agent,
agent fix cycles, then merge or revert. Merge on every repo also
fires the board loop signal (D26): the source board item flips toward
`shipped` when all descendants merge, and a `retro` run may write a
retro card back to the board (S-16).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ veto            ⌘K                                                     │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │ ← SR-0142  Session cache              pr-open · ci-watch[1] │
│  SIDEBAR   │ ─────────────────────────────────────────────────────────── │
│            │                                                             │
│  Inbox   9 │  REPO · backend                                        [2]  │
│  Tickets   │  ┌──────────────────────────────────────────────────────┐  │
│  Review  2 │  │ PR #482  "feat: session cache"          open ↗      │  │
│  Queue   1 │  │                                                        │  │
│  Escal.  2 │  │  CI   ✓ build  ✓ lint  ⏳ e2e (3m)               [3] │  │
│  Metrics   │  │                                                        │  │
│  KB        │  │  Comments                                        [4] │  │
│            │  │  ┌────────────────────────────────────────────────┐  │  │
│            │  │  │ @sara  "rename cacheGet → Get"    auto-fed ⚡  │  │  │
│            │  │  │   └ agent fix queued — cycle 2/5               │  │  │
│            │  │  │ @tom   "LGTM after e2e"           informational │  │  │
│            │  │  └────────────────────────────────────────────────┘  │  │
│            │  │                                                        │  │
│            │  │  fix run 005-ci-fix  ● running      watch →        [5]│  │
│            │  │                                                        │  │
│            │  │            [Merge (squash)]        [Revert]        [6]│  │
│            │  └──────────────────────────────────────────────────────┘  │
│            │  REPO · web    ✓ merged  9b2e04f                    [7]     │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Header** — ticket ref, headline status (`pr-open` / `ci-watch`),
   S-05 back link. Rollup rule: merged only when EVERY repo merged —
   headline stays `ci-watch` on mixed states.
2. **Repo card** — one per `ticket_repos` row: PR number + title +
   link, `pr_state` (open/merged/closed).
3. **CI strip** — per-check chips from `gh` polling
   (`shepherd.poll_interval_s`): ✓ green, ⏳ pending, ✗ failing;
   failing check expands a log tail. `ci_state` rollup badge.
4. **Comments feed** — teammate PR comments; each shows an
   **auto-fed ⚡** badge when the conductor pushed it into a
   comment-fix run, or `informational` when it didn't trigger. Cycle
   counter vs `shepherd_max_cycles` — hitting the cap surfaces an
   escalation.
5. **Fix-run status** — active comment-fix/ci-fix run row with live
   dot → opens S-07. New commits appear as a feed line.
6. **Actions** — **Merge** (enabled when all checks green + DoD
   `verified_by` rows all run; label shows strategy `squash`) and
   **Revert** (confirm → revert run → `reverted`).
7. **Merged repo** — collapses to a one-liner: repo, merged badge,
   `merged_sha` mono.

## Fields

| Element | Source |
| --- | --- |
| Repo card | `ticket_repos`: repo, pr_url, pr_state, ci_state, merged_sha, branch |
| CI | `gh` check runs per PR |
| Comments | `teammate_comment` events + shepherd cycle count |
| Fix run | `runs` row (stage `ci_fix`/`comment_fix`/`rebase`) |

## Interactions

- All live — CI chips and comment feed tick via SSE.
- Merge confirm lists every repo PR to be merged (multi-repo atomicity
  note: repos merge in order; a mid-failure leaves state visible).
- Revert asks squash-merge-sha confirm; lands `reverted` + inbox note.

## Style notes

- Repo cards: zinc-900, 8px radius; CI chips mono 11px.
- Comment thread = same anchored-thread component (S-06/S-08).
- Auto-fed badge: indigo ⚡ + tooltip "fed to agent — fix cycle n/5".
