# SETTINGS — sprint-runner configuration spec

Companion to `PRD.md`. Draft 2026-10-03.
Format: **YAML**. Precedence (highest wins): **ticket frontmatter >
tickets-repo config > global config > defaults**. Secrets live ONLY in
`.env` files or env vars — never in config, tickets, or prompts.

## Files

```
~/.config/sprint-runner/config.yaml         # global defaults
~/.config/sprint-runner/.env                # secrets (gitignored)
<tickets-repo>/.sprint-runner/config.yaml   # per-tickets-repo overrides
<tickets-repo>/.sprint-runner/.env          # per-repo secrets (gitignored)
ticket frontmatter                          # per-ticket overrides
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

# --- repos ---
tickets_repos:                 # the ledger repos; workspace switcher lists these
  - name: team-a
    url: git@github.com:org/team-a-sprint-tickets.git
repos:                         # code repos tickets may target
  backend:
    path: /abs/path/backend
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
                               # worktree-isolated but each run spends
worktree_root: sibling         # sibling → <repo>.worktrees/<id>
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
prior_art_recall: true             # inject {{PRIOR_ART}} into triage/
                                   # design prompts (file-overlap match)

# --- semantic layer ---
semantic:
  embeddings: local            # local | openrouter | off — local keeps
                               # it free + private; sqlite-vec/pgvector
  embedding_model: null        # provider default; 'local' = a bundled
                               # MiniLM-class encoder shipped with the
                               # app — no download, no API spend
  entity_linking: true         # link ticket terms → dossier entities
  dedupe: true                 # semantic near-dup detection (tickets,
                               # findings, gaps)

# --- coordination / state ---
storage_url: sqlite://~/.local/share/sprint-runner/state.db
                             # postgres://… in daemon mode; same schema
leases_via: auto               # auto | db | git-ref  (git-ref CAS fallback)

# --- ingest ---
importers:
  github: {token_env: GITHUB_TOKEN}
  jira:   {base_url: null, token_env: JIRA_TOKEN}   # v1: optional
  default_repo_map: {}         # jira component → repo name, etc.

# --- security ---
security:
  scanner: gitleaks            # gitleaks | trufflehog — scans staged
                               # artifacts before every tickets-repo commit
  scan_on_commit: true         # FAIL-CLOSED — a scan error or finding
                               # blocks the commit + surfaces a repair
                               # inbox item

# --- ux ---
ui:
  bind: 127.0.0.1              # localhost only by default — agents exec
                               # arbitrary code; wider bind = CSRF→RCE door
  port: 4711                   # conductor serves the web UI here
  token_file: ~/.config/sprint-runner/ui-token
                               # auto-generated (32-byte hex, 0600) on
                               # first launch; required on EVERY request
                               # incl. SSE — see API.md
  remote_access: false         # true → bind wider; token still required
                               # everywhere, ?token= bootstrap refused
                               # off-loopback. Tunnel/LAN use (approve
                               # from the couch) — warns on save
voice: auto                    # auto | off  (webview speech api — shell-
                               # dependent: Chromium via Electron,
                               # WKWebView via Tauri; on-device preferred)
notifications: {desktop: true, badge: true}
review:
  auto_fix_severities: [blocker, major]   # minors/nits/questions → human triage
  auto_fix_rounds: 2
```

## Precedence examples

- `model:` in ticket frontmatter > `main_model` in tickets-repo config >
  global.
- `gates: minimal` in a tickets-repo config applies to that repo's
  tickets only.
- Missing repo card → triage auto-probes (executes commands to verify) →
  writes card → `verified: true`. `verified: false` fails pre-flight.

## Secrets

`.env` holds `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `JIRA_TOKEN`, tracker
creds. Loaded per-run; injected into the agent env only when the backend
needs it; agents are prompted never to print env values.
