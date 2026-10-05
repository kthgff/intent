# sprint-runner

Feed a directory of Markdown sprint tickets to the Devin CLI, one ticket at a
time, from your terminal. Each ticket becomes a `devin -p` run in the right
repo, on its own branch, ending with a PR.

> **Note:** `run-tickets.sh` + `sprints/2026-10/` are the v0 prototype and use
> the v0 ticket format documented below (`repo:`, `status: todo|done`). The v1
> product design and its ticket schema live in `PRD.md` and `SCHEMAS.md`;
> `INTELLIGENCE.md` defines the D37 evidence/retrieval/continuous-learning TDD.

## Prerequisites

- Devin CLI installed and authenticated (`devin auth status`)
- `gh` authenticated in each target repo (`gh auth status`) — Devin opens PRs
- Each repo is a clean git worktree before its ticket runs
- `devin` on PATH, or set `DEVIN_BIN` (the script falls back to the
  Devin.app-bundled binary automatically)

## Layout

```
sprint-runner/
  run-tickets.sh          # the runner
  prompt-template.md      # composite prompt; {{TOKENS}} are filled per ticket
  sprints/2026-10/
    sprint.md             # shared context injected into every prompt
    repos.conf            # name=/abs/path mapping for the `repo:` field
    tickets/              # one .md file per ticket
    runs/<id>/            # per-ticket artifacts: prompt.md, devin.log,
                          # export.json, sessions.json, pr-url.txt
```

## Ticket format

```markdown
---
id: ABC-123
title: Short title
status: todo            # todo | in-progress | done | failed | blocked
priority: high          # high | medium | low
repo: backend           # must match a name in repos.conf
model: opus             # optional per-ticket model override
---

## Description
...

## Acceptance criteria
- [ ] ...

## Notes
...
```

## Usage

```bash
./run-tickets.sh                    # run all unfinished tickets, priority order
./run-tickets.sh --dry-run          # print the plan, change nothing
./run-tickets.sh --ticket ABC-123   # run one ticket
./run-tickets.sh --max 3            # cap the number of tickets
./run-tickets.sh --force            # include tickets already marked done
./run-tickets.sh --sprint DIR       # different sprint directory
```

## How it works

1. Collects `tickets/*.md` where `status != done`, sorted by priority.
2. Resolves `repo:` via `repos.conf`, `cd`s into that repo.
3. Refuses to run if the repo is dirty → ticket marked `blocked`.
4. Creates/checks out `ticket/<id>` (lowercased id).
5. Renders `prompt-template.md` → `runs/<id>/prompt.md`, runs:

   ```bash
   devin -p "$(cat runs/<id>/prompt.md)" \
     --permission-mode bypass \
     --respect-workspace-trust false \
     --export runs/<id>/export.json
   ```

6. Parses the log: `PR: <url>` → `status: done` (+ `pr-url.txt`);
   `BLOCKED: <reason>` → `blocked`; anything else → `failed`.
7. Continues to the next ticket — failures never stop the batch.

`failed`/`blocked` tickets are picked up again on the next run (unless you
delete them). To manually follow up on a run, find the session ID in
`runs/<id>/sessions.json` and `devin -r <id>` from that repo's directory.

## ⚠️ Permission mode

Default is `--permission-mode bypass`: Devin auto-approves **every** tool
call, including shell commands and file writes anywhere on your machine —
no sandbox. That's what makes the batch truly unattended, and it means a
misguided run can do real damage. Mitigations built in: clean-tree check,
dedicated branch per ticket, full transcript in `runs/<id>/`.

For guardrails instead, run with `PERMISSION_MODE=smart` or use
`--sandbox --permission-mode autonomous` (edit the script's flags — requires
Devin CLI's sandbox support).

## Cost

Serial runs self-limit, but each ticket is a full agent run. Use `--dry-run`
to preview scope, `--max` to cap spend, and the `model:` frontmatter field to
use cheaper models for small tickets.
