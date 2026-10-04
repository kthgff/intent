# S-02 — Settings

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: all configuration (WF-13) and the tail of first-run onboarding
(WF-01 walks through these tabs in order). Writes `config.yaml`; secrets
are write-only fields that land in `.env` (never read back, per API.md).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K      [All workspaces ▾]            🔔3  ⚙           │
├────────────┬──────────────┬──────────────────────────────────────────────┤
│            │              │  Backends & Keys                       [2]   │
│  SIDEBAR   │  SETTINGS    │  ──────────────────────────────────────────  │
│            │              │                                              │
│  Inbox   9 │  General     │  Backend                          [3]        │
│  Tickets   │  Tickets Repos│  ┌──────────┐ ┌──────────┐                  │
│  Review  2 │  Code Repos  │  │ ◉ devin  │ │ ○ aider  │                  │
│  Queue   1 │  Products    │  │ CLI found│ │ +OpenRouter                 │
│  Escal.  2 │  ─────────── │  └──────────┘ └──────────┘                  │
│  Metrics   │  Backends &  │                                              │
│  KB        │    Keys      │  Permission mode    [smart ▾]       [4]      │
│            │  Gates &     │                                              │
│            │    Budgets   │  Keys (.env — write only)           [5]      │
│            │  Merge       │  ┌────────────────────────────────────────┐  │
│            │  Notifications│ │ OPENROUTER_API_KEY   ••••••• set  [↻] │  │
│            │  Worktrees   │  │ GITHUB_TOKEN         ••••••• set  [↻] │  │
│            │  Advanced    │  │ JIRA_TOKEN           ——— add        │  │
│            │              │  └────────────────────────────────────────┘  │
│            │              │                                              │
│            │              │  Capabilities (auto-detected)       [6]      │
│            │              │  can_exec ✓   write_outside ✓   has_gh ✓    │
│            │              │                                              │
│            │              │                            [Save] [Discard]  │
└────────────┴──────────────┴──────────────────────────────────────────────┘
```

## Annotations

1. **Sub-nav rail** — second-level vertical tabs inside the content
   area (Linear settings pattern). Unsaved-changes dot on the tab;
   leaving with edits → confirm dialog.
2. **Tab header** — section title + one-line description.
3. **Backend picker** — card radio pair (devin / aider). Each card shows
   detection state: `CLI found ✓` / `not found — install or pick aider`.
   Detection runs on open.
4. **Permission mode** — `smart | bypass | accept-edits` select;
   `bypass` shows an inline warning ("agent runs unattended — stalls
   surface as inbox items").
5. **Secrets table** — env-var name, masked state (`set`/`——`),
   rotate button. Values never rendered back — inputs are
   write-once-then-mask.
6. **Capabilities row** — read-only detected flags per backend
   (`can_exec`, `can_write_outside_tree`, `has_gh`) with an "override"
   disclosure for power users.
7. **Save bar** — sticky bottom-right; PUTs whole config section;
   `remote_access: true` or `bypass` → config warns on save (per
   SETTINGS/API) via confirm modal.

## Tabs & fields

| Tab | Fields |
| --- | --- |
| **General** | `actor` (identity — required, highlighted if unset), `storage_url`, `leases_via`, UI: `bind`, `port`, `remote_access` + warning, `voice` |
| **Tickets Repos** | table: name, url, status (cloned/pulls ok), remove; **+ Add** (name + git url → clone); per-repo "has config overrides" chip → opens repo's `.sprint-runner/config.yaml` editor |
| **Code Repos** | table: name, path, `card.verified` badge; expand → **repo card panel**: test/lint/build commands, `forbidden_paths`, `probed_at`, verified state + **Re-probe** button (watchable in S-07); + Add repo (name + path → probe run queued) |
| **Products** | product rollups (one UX spanning N repos → product dossier in S-14). Table: name, `repos[]` (multi-chip picker over code repos), `docs[]` paths, `screenshots` path, `app_url` (optional — Playwright crawl target), `context_file`. + Add product; deleting warns that the product dossier stays until pruned |
| **Backends & Keys** | backend, permission_mode, capabilities, secrets table |
| **Models** | `main_model`, `review_model`, `escalation_model` — free text + suggestions per backend; note: ticket frontmatter can override |
| **Gates & Budgets** | `gates` mode (full / plan-package / minimal — descriptive cards), `spec_depth`, `concurrency.implement`, budgets: spend cap $, token cap, `shepherd_max_cycles`, `fix_dismissal_cap`, `split_max_children` |
| **Merge** | `merge_strategy` (squash/merge/rebase), `shepherd.poll_interval_s` |
| **Notifications** | `notifications.desktop`, `notifications.badge` toggles |
| **Worktrees** | `worktree_root` (sibling vs custom path) + explainer |
| **Advanced** | timeouts table (per stage, seconds), `importers.*` (token_env names, `default_repo_map`), `security.scanner` + `scan_on_commit`, `semantic.*` (embeddings, model, entity_linking, dedupe), `prior_art_recall`, `survey.*` (refresh, timeout, budget, sources) |

## Interactions

- Save is per-tab; dirty indicator per tab rail item.
- Dangerous values (`remote_access`, `bypass`, `scan_on_commit: false`)
  → amber inline warning + confirm on save.
- Repo probe / ticket-repo add launches a run → toast links to S-07.
- Onboarding mode: same tabs rendered as a stepped walkthrough
  (Welcome → Backend → Keys → Tickets repo → Code repos → Models →
  Gates) with a progress rail replacing the tab rail.

## Style notes

- Form rows 40px; labels left column 180px, controls right — Linear
  settings rhythm.
- Cards: zinc-900 bg, zinc-800 border, 6px radius.
- Verified badge green / unverified amber; detection chips mono 11px.
