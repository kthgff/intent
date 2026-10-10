# SETTINGS — Veto configuration spec

Companion to `PRD.md`. Draft 2026-10-03.
Format: **YAML**. Precedence (highest wins): **ticket row fields >
project settings (`projects.settings`, DB) > global config >
defaults** (D29 — the tickets-repo layer moved into the DB). Secrets
live ONLY in `.env` files or env vars — never in config, tickets, or
prompts.

## Files

```
~/.config/veto/config.yaml                  # global defaults
~/.config/veto/.env                         # secrets (gitignored)
projects.settings (Postgres)                # per-project overrides (DB)
tickets row fields                          # per-ticket overrides (DB)
```

## config.yaml

```yaml
schema: 1
actor: null                    # REQUIRED — this install's identity for
                               # machine commits (bot identity), claims,
                               # and event attribution. Set at onboarding.

# --- backends & models ---
backend: devin                 # devin | aider  (v1 ships BOTH)
permission_mode: smart         # smart | bypass | accept-edits —
                               # DEFAULT smart; bypass is opt-in only.
                               # Stalls on risky ops → timeout → human
                               # attention (not silent damage).
main_model: null               # null = backend default; aider: openrouter/<org>/<model>
review_model: null             # separate setting; recommend different family
escalation_model: null         # stronger tier for the retry ladder
                               # (implement retry, pre-escalate triage
                               # retry); null = backend's own step-up
capabilities:                  # per-backend flags; override only if you must
  devin:  {can_exec: true,  can_write_outside_tree: true,  has_gh: true}
  aider:  {can_exec: true,  can_write_outside_tree: false, has_gh: false}

# --- model routing registry (SCHEMAS §21, wp-155) ---
# Every AI interaction KIND resolves through this table — never a
# hardcoded model. `default` is the base layer; a kind's unset fields
# inherit from it, then legacy knobs, then main_model.
models:
  default:
    primary: null              # bare provider id, e.g. anthropic/claude-…
    fallback: []               # ordered failover candidates
    max_output_tokens: null    # per-turn output ceiling
    schema_required: false     # caller demands JSON-schema output
    providers: []              # non-empty = provider allowlist (fail-closed)
    latency_class: null        # instant | interactive | background
  assistant:                   # Board Assistant turns (BOARD-CHAT-TDD)
    primary: qwen/qwen3-30b-a3b-instruct-2507
    providers: [openrouter]    # v1 is OpenRouter-only — a route pinned
                             # elsewhere errors loudly at wiring time
    max_output_tokens: 2048
    # latency_class defaults to `interactive` for this kind
    # OPENROUTER_API_KEY lives in .env (secrets), never here —
    # missing key/model → the assistant degrades deterministically

# --- repos ---
# (projects/workspaces live in the DB `projects` table — created via
#  UI/API, not config. D29.)
repos:                         # code repos tickets may target
  backend:
    path: /abs/path/backend
    url: https://github.com/me/backend   # origin remote — set by the
                                         # Settings → "Add from GitHub"
                                         # clone flow (D60); optional,
                                         # informational
    card:                      # AUTO-PROBE writes this — probed by an agent
      test: make verify        #   run that EXECUTES the commands to verify
      lint: make lint          #   (detection + verification, no human step)
      build: make build
      forbidden_paths: [migrations/prod/, gen/]
      probed_at: 2026-10-03T00:00:00Z
      verified: true           # false → pre-flight fails until re-probed

products:                      # product rollups — one user experience
  myApp:                       #   spanning N repos → product dossier
    repos: [backend, frontend]
    docs: [/abs/path/manuals]  # manuals, FAQs, ADRs, API specs
    screenshots: /abs/path/shots   # UI images for the survey
    app_url: http://localhost:3000 # Playwright crawl target (optional —
                                   # needs playwright installed; crawl
                                   # skipped gracefully otherwise)
    context_file: null         # shared context md injected into all
                               # prompts as {{CONTEXT_MD}} (conventions,
                               # team norms — replaces sprint.md)

# --- knowledge base ---
survey:
  refresh: weekly              # weekly | daily | manual — cron re-survey;
                               # manual sync button in admin always exists
  timeout: 7200                # deep investigation — hours, not minutes
  budget_usd: null             # hard cap per survey run; null = uncapped
  sources: [code, docs, screenshots, crawl]   # + tickets, analytics opt-in

# --- pipeline ---
gates: full                    # full | plan-package | minimal
spec_depth: standard           # light | standard | deep — default tier;
                               # triage may recommend per ticket
merge_strategy: squash         # squash | merge | rebase
concurrency:
  implement: 1                 # MVP default; raise deliberately —
                               # worktree-isolated but each run spends;
                               # N parallel tickets = N running containers
worktree_root: sibling         # sibling → <repo>.worktrees/<id>
containers:                    # D30 — containerized run runtime
  runtime: container           # container | process — default for
                               # container-capable backends (aider);
                               # `process` = detached-OS-process fallback
  image: veto/agent:latest
                               # single shared image: git, gh, aider,
                               # runtimes; repo deps install inside via
                               # repo-card setup. Built/pulled at
                               # conductor start; absent docker daemon =
                               # hard startup error for container backends
  cpu: 2                       # --cpus cap per ticket container
  memory: 4g                   # --memory cap per ticket container
  stop_on_gate: true           # docker stop when ticket parks at a gate;
                               # start on next launch; rm on terminal status
timeouts:                      # seconds per run type; kill on expiry
  interview: 900
  import: 600
  probe: 600
  triage: 900
  split: 900
  prd: 1800
  design: 1800
  testplan: 1200
  implement: 7200
  review: 1800                 # per pass
  fix: 1800
  doc_repair: 600
  discuss: 600
  escalate: 900
  ci_fix: 1800
  comment_fix: 1800
  rebase: 900
  revert: 1800
  verify: 3600                 # runner-side suite re-runs (no agent);
                               # survey uses survey.timeout
shepherd:
  poll_interval_s: 60          # gh checks + comment polling per open PR

# --- budgets (anti-spin for money) ---
budgets:
  spend_cap_usd_per_ticket: null   # null = uncapped; hard ceiling if set
  tokens_cap_per_ticket: null      # in+out ceiling; same kill-switch —
                                   # bounds backends with no $ (devin's
                                   # billing isn't token-priced)
  shepherd_max_cycles: 5           # teammate-comment→fix cycles per PR
  fix_dismissal_cap: 2             # self-dismissed findings/run before
                                   # ALL findings escalate to human
  split_max_children: 5            # max child tickets per split run

# --- Scope Creep Radar budgets (PRD §15.5, wp-142) ---
# Every knob is a hard ceiling; a ChangeSet whose computed radar
# breaches ANY set threshold escalates to the `scope-budget` gate —
# approving decisions + apply refuse until a human clears it (the
# higher approval). Unset keys never fire; radar metrics are always
# computed and visible regardless.
scope_budgets:
  cost_usd: null               # Σ events.cost_usd over the change's blast radius
  schedule_days: null          # oldest pinned baseline age (baseline staleness)
  scope_pct: null              # (added+removed) ÷ baseline scope size, fraction
  post_approval_changes: null  # changesets touching ratified scope
  rework_events: null          # changes-requested loops + fix rounds + revalidations
  affected_executions: null    # live runs the change would interrupt
prior_art_recall: true             # inject {{PRIOR_ART}} into triage/
                                   # design prompts (file-overlap match)

# --- semantic layer ---
semantic:
  embeddings: local            # local | openrouter | off — local keeps
                               # it free + private; pgvector
  embedding_model: null        # provider default; 'local' = a bundled
                               # MiniLM-class encoder shipped with the
                               # app — no download, no API spend
  entity_linking: true         # link ticket terms → dossier entities
  dedupe: true                 # semantic near-dup detection (tickets,
                               # findings, gaps)

# --- evidence plane / code intelligence (D37) ---
intelligence:
  code_index: true             # commit-pinned code units + FTS; when false,
                               # code retrieval degrades to live exact search
  grounding: true              # default-on evidence for PRD/TDD/test/
                               # implementation/review; user may disable
  index_on_project_connect: true
  reindex_on_default_branch_change: true
  parser: tree-sitter          # fallback chunks unsupported/broken files
  incremental: true            # reuse content hashes; changed/deleted paths only
  max_results: 20
  context_tokens: 8000         # hard evidence-bundle budget per stage
  allow_stale: false           # false = stale evidence is labeled/excluded
  structural_depth: 2          # bounded graph expansion; prevents context blowup
  prd_quality: true            # cited AI quality findings; spec_score remains
                               # deterministic/advisory and is not replaced
  critical_prd_findings: block # block | advisory; block allows explicit
                               # human waiver with recorded rationale
  auto_verify_confidence: 0.90 # >= threshold → visibly `auto-verified`;
                               # below it requires human verification
  alignment: off               # off | manual | on-merge (Phase B)
  evaluation_suite: null       # path/ref to versioned retrieval golden set
  exclude: []                  # extra generated/vendor/forbidden globs;
                               # VCS ignores + secret/binary rules always apply

# Phase C (D37): no connector is enabled by default. Connector config stores
# secret ENV NAMES only. Raw telemetry remains in its backend.
telemetry:
  enabled: false
  first_connector: otlp        # D37 decision: OpenTelemetry/OTLP first
  redaction_policy: telemetry-redaction-v1
  fingerprint_version: v1
  representative_max_bytes: 8192
  retention_days: 90           # signatures/investigations, not raw events
  draft_ticket_threshold:      # crossing creates a DRAFT proposal only;
    count: 25                  # actual ticket always requires human approval
    window_minutes: 15
    regression_multiplier: 2.0
  sources: []                  # {id, kind: otlp|loki|opensearch|file|...,
                               #  endpoint?, token_env?, project}

# --- coordination / state ---
database:                    # D38 — desktop/daemon manages local Docker PG
  mode: managed-docker       # managed-docker is the v1 production mode
  image: pgvector/pgvector:0.8.6-pg17-bookworm
                             # release build also pins the image digest
  container: veto-postgres
  volume: veto-postgres-data
  port: auto                 # loopback-only dynamic published port
  startup_timeout_s: 60
  backup_dir: ~/.local/share/veto/backups
storage_url: null            # derived from managed container + `.env`
                             # password; explicit URL = dev/test override
                             # only. PGlite is test-only.

# --- ingest ---
importers:
  github: {token_env: GITHUB_TOKEN}
  jira:   {base_url: null, token_env: JIRA_TOKEN}   # v1: optional
  default_repo_map: {}         # jira component → repo name, etc.

# --- security ---
security:
  scanner: gitleaks            # gitleaks | trufflehog — scans staged
                               # artifacts before every code-repo commit
  scan_on_commit: true         # FAIL-CLOSED — a scan error or finding
                               # blocks the commit + surfaces a repair
                               # inbox item

# --- ux ---
ui:
  theme: system                # system | dark | light (D34) — system
                               # follows prefers-color-scheme live
  bind: 127.0.0.1              # localhost only by default — agents exec
                               # arbitrary code; wider bind = CSRF→RCE door
  port: 4711                   # conductor serves the web UI here
  token_file: ~/.config/veto/ui-token
                               # auto-generated (32-byte hex, 0600) on
                               # first launch; required on EVERY request
                               # incl. SSE — see API.md
  remote_access: false         # true → bind wider; token still required
                               # everywhere, ?token= bootstrap refused
                               # off-loopback. Tunnel/LAN use (approve
                               # from the couch) — warns on save
  idea_canvas_v2: false        # s-16 spatial canvas on idea boards (D57);
                               # default off until dogfood — flag-off keeps
                               # the grouped classic view (rollback = flip)
  canvas_draw: false           # drawing layer on the v2 canvas (D63) —
                               # pen/shapes/highlighter → board_annotations;
                               # requires idea_canvas_v2
  board_chat: false            # Board Assistant panel + ghost proposals
                               # (BOARD-CHAT-PRD); requires idea_canvas_v2 —
                               # flag-off keeps the board read-only to the
                               # assistant (no panel, no proposal surface)
  draft_recovery: true         # versioned non-secret localStorage drafts;
                               # reconnect protection, NOT offline sync
voice: auto                    # auto | off  (webview speech api — shell-
                               # dependent: WKWebView on macOS, WebView2 on
                               # Windows via Tauri; on-device preferred)
notifications: {desktop: true, badge: true}
review:
  auto_fix_severities: [blocker, major]   # minors/nits/questions → human triage
  auto_fix_rounds: 2
```

## Precedence examples

- `model` on the ticket row > `main_model` in `projects.settings` >
  global.
- `gates: minimal` in a project's `settings` applies to that project's
  tickets only.
- Missing repo card → triage auto-probes (executes commands to verify) →
  writes card → `verified: true`. `verified: false` fails pre-flight.

## Secrets

`.env` holds `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `JIRA_TOKEN`, tracker
creds. Loaded per-run; injected into the agent env only when the backend
needs it; agents are prompted never to print env values.
