# S-04 — Q&A wizard

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: THE shared question surface — one question at a time, answered
fast or skipped to the recommended default. Backed by
`triage.json.questions[]` (SCHEMAS §5). Reused for triage needs-info,
design-Q&A, test-plan Q&A, interview mode, and fix-triage — context
header changes, the card doesn't.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K                                                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│            SR-0142 · team-a · triage — round 2                   [1]       │
│            ●●●○○○○   3 of 7 · ~2 min                        [2]          │
│                                                                          │
│            ┌────────────────────────────────────────────────┐            │
│            │  Which cache backend for sessions?       [3]    │            │
│            │  The TDD needs this before the file plan       │            │
│            │  can settle — worker.go already uses Redis.    │            │
│            │                                                │            │
│            │  ┌────────────────────────────────────────┐    │            │
│            │  │  B  Redis — reuse existing infra   ★rec │ [4]│            │
│            │  ├────────────────────────────────────────┤    │            │
│            │  │  A  Postgres LISTEN/NOTIFY              │    │            │
│            │  ├────────────────────────────────────────┤    │            │
│            │  │  C  In-process LRU                      │    │            │
│            │  ├────────────────────────────────────────┤    │            │
│            │  │  ✎  Other…                          🎙 │ [5]│            │
│            │  └────────────────────────────────────────┘    │            │
│            │                                                │            │
│            │   [Skip = accept recommended]  [Accept all] [6]│            │
│            └────────────────────────────────────────────────┘            │
│                                                                          │
│      bail: force-ready · wont-do                     ticket →   [7]      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Context header** — ticket ref, workspace, stage context
   (`triage · round 2`, `interview`, `design-Q&A`), links to S-05.
   Centered single-column layout — this screen is a focus mode.
2. **Progress rail** — dots per question (answered ● filled,
   auto-accepted half, open hollow) + count + rough remaining-time
   estimate. Clickable to revisit.
3. **Question card** — `question` text + `why` (why the agent needs it)
   as a muted sub-line. `why` is what makes answering informed —
   always visible, never behind a disclosure.
4. **Options list** — from `options[]`: key letter, label,
   `★ recommended` badge on `recommended: true`. Format-aware:
   `yesno` = two options, `single` = radio list, `multi` = checkboxes,
   `text` = free-text field only.
5. **Other + mic** — `allow_other` → free-text row with dictation mic
   (webview speech API; hidden when `voice: off` or unsupported).
6. **Fast-path actions** — `Skip` applies `default` (records
   `status: skipped`, `auto: true`); `Accept all` batch-accepts every
   recommended default → POST answers → commit → re-run.
7. **Bail-outs** — muted footer links (confirm modals): `force-ready`
   skips remaining spec gates, `wont-do` kills the ticket. `ticket →`
   opens S-05 without leaving context.

## Fields (from SCHEMAS §5)

| Element | Field |
| --- | --- |
| Header | `ticket`, `round`, stage context |
| Question | `id`, `question`, `why`, `format` |
| Option | `key`, `label`, `recommended` |
| State | `status` (open/answered/skipped), `answer`, `auto`, `answered_by` |
| Side panel (optional disclosure) | `spec_lint` score+flags, `files_likely_touched`, `entities_referenced` — context for power users |

## Interactions

- Answering commits immediately per question (batch POST allowed) —
  wizard is resilient to closing mid-way; reopening resumes at first
  `open` question.
- Number keys 1-9 select options; `Enter` confirm; `s` skip;
  `a` accept-all (confirm); `←/→` prev/next.
- Claimed-by-other state: read-only banner + "claimed by K".
- Last question → "Re-triaging…" → auto-navigate to S-05 or back to
  inbox item cleared.

## Style notes

- Max-width 640px centered; card is the only surface chrome.
- Recommended option: indigo left-border + `★rec` chip.
- Progress dots 6px, zinc-700 hollow / zinc-100 filled.
- Mic button pulses while listening; falls back to text-only silently.
