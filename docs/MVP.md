# MVP — Veto v1 cutline

Companion to `PRD.md`. Draft 2026-10-03 (revised: **MVP includes the
full UI** — there is no zero-UI mode; github.com flows are secondary
channels, not the product).

**User story:** As an engineer, I want to author or import a ticket,
have AI help me forge it into a rigorous spec — PRD, TDD, test plan —
then let agents implement it while my judgment stays the gate — so the
code that lands was *specified* well, not just *generated* fast.

**MVP definition:** the complete product — engine, conductor, knowledge
base, and the full desktop UI.

## IN — v1

- **Full UI** — the complete screen inventory (S-01…S-20 per
  UI-INVENTORY.md) as a web app served by the
  conductor on localhost, wrapped in a thin desktop shell (Tauri
  2, macOS + Windows) for dock/notifications/badge/launch-on-login presence;
  identical surface reachable in any browser incl. daemon mode —
  wire contract = REST + SSE (`API.md`):
  needs-attention inbox, settings, create/import (interview), Q&A
  wizard, ticket detail, doc reviewer, run monitor, code review page,
  PR panel, escalations/failures, ledger browser, metrics dashboard,
  workspace switcher, knowledge base
- **Engine**: babysitter conductor (auto-advances all non-gate
  transitions), stage runs in per-ticket Docker containers (D30 —
  aider runtime; `process` fallback) + detached verify tasks
  (runner-side suite re-runs), per-stage timeouts, kill/pause/abort,
  Postgres state (D29 — leases, runs, claims, dossiers, entities,
  embeddings, tickets, doc_versions, events; PGlite in tests)
- **Spend checkpoint**: `test-approved →` human "go" button with cost
  estimate → implement fires
- **DB truth** (D29): `tickets`/`doc_versions`/`events` rows,
  generated `LOG.md` render, gitleaks fail-closed sanitizer,
  bot-identity commits under `actor:` config; git = code delivery only
  (worktrees, branches, PRs)
- **Pipeline**: interview-mode authoring → GitHub importer + manual MDs
  → spec lint → triage → needs-info → PRD → tech-Q&A → TDD → test plan
  → implement → multi-pass review → severity-gated fixes → human
  approve → PR → shepherd (CI watch, teammate comments, rebase run) →
  merge → revert path
- **Spec machinery**: spec linter, verifiable ACs, DoD section, spec-bug
  feedback loop, deviation-rate metric, depth tiers, auto-split,
  prior-art recall (file-overlap + local embeddings)
- **Knowledge base**: full survey — code + docs + screenshots +
  Playwright crawl → dossier (architecture, workflows, personas, gaps)
  in DB; manual Sync + scheduled refresh; human-correction
- **Semantic layer**: entities + typed relations (ontology-lite), local
  embeddings (pgvector), deviation/question taxonomies, entity linking
- **Both backends**: devin CLI + aider/OpenRouter, capability-flagged;
  aider default runtime `container` (D30)

## OUT — v1 (deferred, designed-for)

- **Immediate post-launch (D37 Phase A):** automatic-on-project-connect,
  commit-pinned code index; default-branch incremental refresh; default-on but
  configurable evidence grounding; exact/FTS + semantic + structural
  retrieval; citations; PRD-quality blocking/waiver; and traceability with
  ≥0.90 visibly labeled auto-verification.
- Jira / Linear importers (importer contract is ready; GitHub ships)
- Headless daemon deployment mode (engine is built for it)
- Remote embedding providers; analytics/support-ticket connectors;
  incremental update-on-merge (manual + cron refresh is v1)
- Continuous-alignment automation, rich call/data-flow analysis, feedback
  clustering, release-risk narratives, and production telemetry/incident
  intelligence (D37 Phases B/C). The schema/adapter seams are specified, but
  v1 does not ingest or embed raw logs.
- Per-stage model routing (config seam exists: main_model/review_model)
- Assignment/roles on shared queue (claims + attribution ship; roles later)
- OS-keychain secrets (.env is v1; keychain is a hardening tier)
- Whisper-class voice (webview speech API is the v1 path — shell-dependent)
- Voice-driven workflows beyond text-field dictation

## Pilot plan (informs tuning — explicitly NOT a build gate)

Run ≥3 real tickets through the pipeline end-to-end. Record
(observed in the `events` table): tickets→PR rate, human-minutes/ticket,
cost/ticket, failure stages, reviewer FP/churn rate, deviation rate
(headline spec-quality metric), spec-score trend.
