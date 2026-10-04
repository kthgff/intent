# Design — screen specs

Per-screen design docs for the web UI (wp-080 scope). Status: draft
2026-10-03. Companion to `UI-INVENTORY.md` (which is binding — these
docs detail fields and layout, they don't re-spec behavior).

## Conventions (all screens)

- **Stack:** React + Vite SPA, served by the conductor on `ui.bind`:
  `ui.port` (REST + SSE per API.md). Tailwind + shadcn/ui (Radix).
- **Style:** Linear-inspired — dark-first (zinc-950 canvas, zinc-900
  cards), 13px Inter base, JetBrains Mono for ids/numbers/logs, one
  indigo accent, 32px list rows, minimal chrome.
- **Anatomy:** persistent left sidebar (nav + badge counts +
  workspaces) on list/queue screens; centered single column on focus
  screens (S-04, S-06); three-rail (nav / content / context) on
  object screens (S-05, S-14).
- **Baselines (every screen, per wp-080 AC):** designed empty and
  error states on every list/queue view; full keyboard parity (all
  pointer actions reachable, visible focus ring); labels accompany
  every color/icon signal; aria roles on live regions (inbox counts,
  run status) so SSE updates announce; content collapses cleanly at
  1024×768 with rails stacking under content.

## Shared vocabulary

| Glyph | Meaning |
| --- | --- |
| `●` / `○` | agent-blocked vs human-step inbox item |
| `◐nn` | spec_score badge (red <50 · amber <75 · green ≥75) |
| `★rec` | recommended option in a wizard |
| `⚡` | auto-fed to agent (PR comments) |
| `~est` | estimated usage (never silent — `usage_source`) |
| `—` | not computable (e.g. non-token-priced backend) |

## Keyboard vocabulary

Global: `⌘K` palette · `?` shortcut sheet · `j/k` move · `Enter` open.
Context-scoped actions (same key, different screen — never global):
`a` = accept-all (S-04) / approve (S-06) · `f` = send-to-fix (S-08) /
follow (S-07) · `d` = dismiss (S-08) / diff toggle (S-06) ·
`w` = wontfix (S-08) · `x` = snooze (S-01) · `c` = claim (S-01, S-10) ·
`s` = skip (S-04) · `space` = pause/resume (S-07) · `e` = edit.

## Screens

Visual mockups: `mockups/*.png` — rendered from `packages/ui` demo mode
(`?demo=1` fixtures). [SCREEN-MATRIX.md](SCREEN-MATRIX.md) is the
implementation contract mapping each screen to its route, required
states, shared primitives, and API gaps.

| Doc | Screen | Workflows |
| --- | --- | --- |
| [s-01-inbox](s-01-inbox.md) | Needs-attention inbox (home) | WF-12 daily loop |
| [s-02-settings](s-02-settings.md) | Settings (+ onboarding) | WF-01, WF-13 |
| [s-03-create-import](s-03-create-import.md) | Create / Import | WF-02 |
| [s-04-qa-wizard](s-04-qa-wizard.md) | Q&A wizard (shared) | WF-03, interview |
| [s-05-ticket-detail](s-05-ticket-detail.md) | Ticket detail | WF-03…WF-11 hub |
| [s-06-doc-review](s-06-doc-review.md) | Doc review (+ split-plan) | WF-04, WF-15 |
| [s-07-run-monitor](s-07-run-monitor.md) | Live run monitor | WF-05, WF-11 |
| [s-08-code-review](s-08-code-review.md) | Code review | WF-06 |
| [s-09-pr-panel](s-09-pr-panel.md) | PR status panel | WF-07 |
| [s-10-escalations](s-10-escalations.md) | Escalations & failures | WF-08, WF-09 |
| [s-11-ledger](s-11-ledger.md) | Ledger browser | WF-10 |
| [s-12-metrics](s-12-metrics.md) | Metrics dashboard | WF-14 |
| [s-13-workspaces](s-13-workspaces.md) | Workspace switcher | WF-13 |
| [s-14-knowledge-base](s-14-knowledge-base.md) | Knowledge base | WF-16, WF-17 |

## Open items tracked elsewhere

- `gate_items.snoozed_until` + `/inbox` field — TRACKER follow-ups (D20)
- `GET /tickets/<ref>/review` route — TRACKER follow-ups (wp-080)
- Chart lib for S-12 — decide at wp kickoff (≥7-day vetting rule)
