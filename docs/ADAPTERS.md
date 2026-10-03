# ADAPTERS — backend interface contract

Companion to `CONDUCTOR.md`. Draft 2026-10-03.
Every backend implements the same contract; capability flags (SETTINGS
`capabilities:`) tell the conductor how to render and collect.

## The contract

```
prepare(subject, stage, ctx) -> RenderedPrompt
  - pick prompt template for stage
  - inject tokens per the prompt's token table
  - inject ARTIFACT_TARGETS per capabilities
  - `subject` is usually a ticket; may be `survey:<scope>:<name>`,
    `probe:<repo>`, `import:<source>`, `interview:<run>` — non-ticket
    runs take the same lease/registry path
run(worktree, rendered, timeout) -> RunHandle
  - spawn detached process; return {pid, log_path}
control(handle, op) -> ok
  - op ∈ kill (SIGTERM → SIGKILL after grace) | pause (SIGSTOP) |
    resume (SIGCONT) — POSIX signals; a runtime that can't signal a
    child declares so in capabilities and the UI hides pause
on_usage(handle, cb)
  - adapters that can stream per-message usage invoke cb →
    `usage_partial` {tokens_in, tokens_out, tokens_cached} to the
    conductor; adapters that can't simply never call back
collect(handle, ctx) -> RunResult
  - wait/stream until exit
  - gather artifacts per ARTIFACT_TARGETS
  - parse LAST non-empty line → sentinel
  - extract usage → calls[] / totals + granularity + source
  -> {sentinel, sentinel_raw, artifacts[], usage, exit_code}
```

## Capability flags → behavior

| Flag | Meaning | Effect |
| --- | --- | --- |
| `can_exec` | can run shell commands | repo-card commands included in prompt |
| `can_write_outside_tree` | can write outside the repo | `ARTIFACT_TARGETS` = absolute `runs/<id>/` paths |
| `has_gh` | can run `gh` | PR creation in-prompt vs runner-owned |

**ARTIFACT_TARGETS**: when `can_write_outside_tree` is false, the
token renders as a **worktree-relative scratch dir**
`.sprint-runner/<run-id>/` (gitignored — the runner adds
`.sprint-runner/` to `.gitignore` on worktree creation). The runner
collects artifacts from the scratch dir into `runs/<id>/` post-exit
and purges it — the diff never sees them.

## Backend specifics (v1)

- **devin**: `devin -p <rendered>` in the worktree,
  `--permission-mode <mode>`, `--export <run_dir>/export.json`.
  Full flags: exec/outside-tree/gh all true. Usage: parsed from
  export.json post-run — `run-aggregate` granularity unless the
  export exposes per-call data; `cost_usd` null (non-token billing).
  **Verified flags (2026-10-03, Devin.app bundled binary)**: real
  permission modes are `auto | accept-edits | smart | dangerous` —
  v0's "bypass" maps to `dangerous`, and `permission_mode: smart`
  passes through unchanged. `--prompt-file <FILE>` exists and is
  preferred over `-p "$(cat …)"` for large rendered prompts.
  `--respect-workspace-trust false` required non-interactive in
  untrusted dirs. `--sandbox` (seatbelt/bwrap) available as a
  hardening option. Binary discovery: `devin` on PATH, else
  `DEVIN_BIN`, else Devin.app bundled path
  (`…/app/extensions/windsurf/devin/bin/devin`).
- **aider** (OpenRouter BYOK): `aider --message-file <rendered.md>
  --yes-always --auto-commits --model openrouter/<model>` in the
  worktree. Flags: `can_exec: true`, `can_write_outside_tree: false`,
  `has_gh: false` → scratch-dir artifacts; runner owns push + `gh pr`.
  Usage: per-message token counts stream-parsed from stdout →
  `per-call` granularity + live monitor counter; `cost_usd` = tokens ×
  OpenRouter price table. Exact flag set verified during M2 spike.

## Usage accounting (per-run token ledger → usage.json)

Every adapter must produce usage data; depth varies by what the
harness exposes, declared via `granularity`:

- **Stream where supported**: adapters that can parse per-message
  usage mid-run (aider prints token counts per exchange) emit
  `usage_partial` to the conductor → live counter in the run monitor
  + `runs.tokens_*` updated in place.
- **Post-run extraction**: backends whose usage only exists in a
  final export (devin `--export`) → `run-aggregate` granularity,
  parsed at `collect`.
- **Estimation fallback**: when the harness reports nothing —
  `tokens_in` is always exact (the runner rendered the prompt);
  `tokens_out` estimated via tokenizer, flagged `source: estimated`.
  A labeled estimate beats a fabricated `reported`.
- **cost_usd**: computed from tokens × the backend's price table
  where token-priced (OpenRouter); `null` for non-token billing
  (devin) — never synthesize dollars.
- Usage extraction failure never fails the run — worst case is
  `source: estimated` on all fields.

## Failure mapping

| RunResult | Conductor action |
| --- | --- |
| valid sentinel + clean artifacts | transition per state machine |
| sentinel missing/malformed | `run_failed` (retry ladder applies) |
| structured artifact fails lint | `doc-repair` run → `repair` gate item, ticket holds |
| exit code timeout (124) | `run_killed`, `aborted`-eligible |
| no commits + no artifacts | `failed`, reason from log tail |
| usage extraction fails/absent | usage.json written with `source: estimated` — never blocks |

## Token table (which {{TOKENS}} each prompt consumes)

| Token | Source | Used by |
| --- | --- | --- |
| `TICKET_ID` / `TICKET_MD` / `TICKET_DIR` | ticket frontmatter + file | all |
| `TICKETS_DIR` | tickets repo root | import, interview |
| `CONTEXT_MD` | `products.<p>.context_file` (empty if unset) | triage, interview, prd, design, split, import |
| `REPO_NAME(S)` / `REPO_CARDS` | settings `repos:` + cards | all repo-touching stages |
| `REPO_PATH` / `CARD_PATH` | settings | probe |
| `ARTIFACT_TARGETS` | absolute `runs/<id>/` or `.sprint-runner/<run-id>/` scratch per `can_write_outside_tree` | all |
| `DEPTH` | frontmatter `depth:` (triage-recommended) | prd, design, testplan, implement |
| `DOSSIER` | scoped dossier sections by touched area; `"dossier pending"` if unsurveyed | triage, interview, design, testplan |
| `PRIOR_ART` | file-overlap + embedding-similar past tickets | triage, interview, design |
| `SPEC_LINT` | runner's mechanical spec score + flags | triage |
| `PRD_MD` / `TDD_MD` / `TEST_MD` | approved spec docs | prd→implement chain |
| `DIFF` / `DEVIATIONS_MD` | worktree diff + deviation file | review, fix, rebase |
| `FINDINGS_JSON` / `FINDING` / `THREAD_JSON` | review.json slices | fix, discuss |
| `BRANCH` | `ticket/<id>` | implement, fix, ci-fix, comment-fix, rebase, revert |
| `CI_FAILURE_LOGS` / `CYCLE` / `MAX_CYCLES` | PR check output + budget | ci-fix, comment-fix |
| `PR_COMMENTS_JSON` | `gh api` pull of open-PR review comments | comment-fix |
| `PR_URL` / `MERGED_SHA` | shepherd state | revert |
| `DOC_PATH` / `LINT_ERRORS` / `SCHEMA_REF` | conductor lint output | doc-repair |
| `ESCALATION_REASON` / `TRIAGE_JSON` | conductor + artifacts | escalate |
| `SEED_TEXT` / `NEW_ID` | human's rough idea · conductor's next-id reservation | interview |
| `SPLIT_MAX_CHILDREN` | budgets | split |
| `SURVEY_BUDGET` / `APP_URL` / `DOC_PATHS` / `SCREENSHOT_DIR` / `EXTRA_SOURCES` / `PRIOR_DOSSIER` / `SEMANTIC_OUT` / `DOSSIER_OUT` / `SCOPE` / `SCOPE_NAME` | settings + prior DB state | survey |
| `PASS_NAME` / `PASS_FOCUS` / `DIFF` | per-pass injection | review-base |
| `DISMISSAL_CAP` / `CAPABILITY_NOTES` | budgets + backend flags | fix, implement |
| `RAW_ISSUES_JSON` / `REPO_MAP` | tracker fetch + settings | import |

## Devin adapter — spike findings (2026-10-03)

Binary: `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`
(Devin.app bundle, Sep-29 build; `devin` NOT on PATH, `DEVIN_BIN` unset
on the spike machine — bundle-path fallback is the live path).

- `devin --help` confirms the documented flag surface:
  `-p, --print [<PROMPT>]` (optional inline prompt — `-p` alone + a
  `--prompt-file` is legal), `--prompt-file <FILE>`,
  `--permission-mode` ∈ `auto | accept-edits | smart | dangerous`
  (env `DEVIN_PERMISSION_MODE`, default `auto`), `--export [<PATH>]`
  ("exports after each turn"), `--respect-workspace-trust [true|false]`,
  `--model <MODEL>` (env `DEVIN_MODEL`), `--sandbox` (seatbelt/bwrap).
- Permission mapping stands: config `smart`→`smart`,
  `bypass`→`dangerous`, `accept-edits`→`accept-edits`.
- `devin acp` exists: ACP (Agent Client Protocol) server over stdio,
  with `--agent-type` (`summarizer`, `review`) and `--model` /
  `--refusal-fallback` — a possible future structured-interaction/
  streaming-usage channel. Noted; NOT implemented in wp-022.
- **Export schema unknown — auth blocked.** `devin auth status` →
  "Not logged in"; a minimal `-p "say OK" --export` run launches the
  interactive login flow and dies (`Error: Login canceled`) producing
  no export. Per spike rules, not retried. The devin usage extractor
  therefore parses defensively: it recognizes several plausible
  token-field spellings (`usage`/`token_usage`/`totals` objects and
  per-message `messages[].usage` with
  `tokens_in|input_tokens|prompt_tokens` /
  `tokens_out|output_tokens|completion_tokens` /
  `cached|cached_tokens|cache_read_input_tokens`), and falls back to
  `source: estimated` when the export carries nothing — usage
  extraction never fails the run (failure-mapping table). Revisit with
  a real export fixture once auth exists on a dev machine.
- Failure mode worth noting: unauthenticated `devin -p` exits fast
  with "Welcome to Devin CLI! … Login canceled" on stdout and no
  sentinel → sentinel missing → `run_failed` per contract (clean).

## Adding a backend

Implement `prepare/run/collect` (+ `control`/`on_usage` if the runtime
supports signals and streamed usage), declare the three flags, register
a name in `capabilities:` — no conductor changes.
