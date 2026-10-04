# S-03 — Create / Import

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: the two entry points for tickets (WF-02) — **Interview**
(rough idea → AI interview → well-formed ticket.md committed) and
**Import** (external source → preview+edit → commit). Both land tickets
at `imported` → spec lint → triage.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [All workspaces ▾]            🔔3  ⚙           │
├────────────┬─────────────────────────────────────────────────────────────┤
│            │  New tickets                                     [workspace]│
│  SIDEBAR   │  ────────────────────────────────────────────────────────── │
│            │  ┌ Interview ─────────┬─── Import ────────────────┐  [1]    │
│  Inbox   9 │  │                                       [2]       │        │
│  Tickets   │  │  Source [GitHub|CSV|Jira*]  into  [team-a ▾]   │        │
│  Review  2 │  │                                        [3]      │        │
│  Queue   1 │  │  Milestone / query                               │        │
│  Escal.  2 │  │  ┌─────────────────────────────────────────┐    │        │
│  Metrics   │  │  │ v2.4 ▾          or   label:sprint JQL… │    │        │
│  KB        │  │  └─────────────────────────────────────────┘    │        │
│            │  │                                        [4]      │        │
│            │  │  Preview — 6 issues          [Refresh]          │        │
│            │  │  ┌─────────────────────────────────────────┐    │        │
│            │  │  │ ☑ #412  Session cache   P1  → backend   │ ✎ │ [5]    │
│            │  │  │ ☑ #418  Export CSV      P2  → ——        │ ✎ │        │
│            │  │  │ ☐ #421  spike: websock… P3  → ——        │ ✎ │        │
│            │  │  └─────────────────────────────────────────┘    │        │
│            │  │                                                │        │
│            │  │              [Import 4 selected → commit]  [6]  │        │
│            │  └────────────────────────────────────────────────┘        │
└────────────┴─────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Tab pair** — Interview | Import, full-width segmented control.
   Workspace target picker top-right (required — tickets land in one
   tickets repo).
2. **Source picker** — GitHub (milestone/issue-query) and CSV file
   (v1 sources per WF-02); Jira shown disabled with "post-v1" hint
   (MVP defers Jira/Linear).
3. **Query input** — per-source: GitHub milestone dropdown or
   `label:`/search query; **CSV → file picker then a column-mapping
   step** (map csv columns → title / description / priority / repos /
   source_id before preview renders); JQL box reserved for Jira.
4. **Preview** — fetched rows rendered before anything is written;
   Refresh re-runs the query.
5. **Preview table** — checkbox, source id + title, suggested priority
   (editable select), suggested repo map (editable multi-chip,
   `→ ——` = unmapped → imports with `repos: []`, triage flags it),
   row-level ✎ expand to edit title/description before import.
6. **Import CTA** — count reflects checked rows; commits ticket folders
   to the tickets repo; result toast links each new id to S-05.

## Interview tab

```
│  Describe what you want built — rough is fine, the interview    │
│  will dig.                                      [workspace ▾]  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ "We keep getting paged when the ETL stalls — add a       │   │
│  │  heartbeat + alert path…"                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│  depth hint [auto ▾]                          [Start interview] │
```

- **Seed textarea** — free text, ≥1 line to enable start.
- **Depth hint** — optional light/standard/deep preselect; default
  `auto` lets triage recommend.
- **Start interview** → POST → interview run; the screen transitions to
  **S-04 wizard** (interview context) as questions stream in; a
  run-monitor strip at top links to S-07.
- **Completion** → ticket.md preview (rendered frontmatter + body,
  spec-lint score badge) → **Commit** writes `tickets/<id>/ticket.md`.

## Fields

| Zone | Fields |
| --- | --- |
| Import config | source (github / csv / jira*), workspace, query-or-file, column mapping (csv), auth env display (`GITHUB_TOKEN set ✓`; *jira post-v1) |
| Preview row | selected, source_id, title (editable), priority (editable), repos (editable chips), description (expand) |
| Interview | seed text, workspace, depth hint |
| Result | ticket id, spec_score badge, edit-before-commit link |

## Interactions

- Import is idempotent — re-running skips existing `source:` ids and
  reports "2 already imported".
- Id collision → flagged row in preview (never renumbered).
- Both flows are runs under the hood: failure → toast + S-10 entry.

## Style notes

- Same segmented-control + content card pattern as S-02 tabs.
- Preview table: dense 32px rows, mono ids, editable cells turn
  zinc-800 on focus.
- Empty preview state: ghost rows + "Run a query to preview".
