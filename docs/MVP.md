# MVP — sprint-runner v1 cutline

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

- **Full UI** — all 14 screens (S-01…S-14) as a web app served by the
  conductor on localhost, wrapped in a thin desktop shell (Tauri
  preferred) for dock/notifications/badge/launch-on-login presence;
  identical surface reachable in any browser incl. daemon mode —
  wire contract = REST + SSE (`API.md`):
  needs-attention inbox, settings, create/import (interview), Q&A
  wizard, ticket detail, doc reviewer, run monitor, code review page,
  PR panel, escalations/failures, ledger browser, metrics dashboard,
  workspace switcher, knowledge base
- **Engine**: babysitter conductor (auto-advances all non-gate
  transitions), detached runs + detached verify tasks (runner-side
  suite re-runs), per-stage timeouts, kill/pause/abort, SQLite
  state (leases, runs, claims, dossiers, entities, embeddings,
  ticket/repo projections, event index)
- **Spend checkpoint**: `test-approved →` human "go" button with cost
  estimate → implement fires
- **Tickets repo**: clone/pull/push, ticket folders, `events.jsonl` +
  generated `LOG.md`, gitleaks fail-closed sanitizer, bot-identity
  commits under `actor:` config
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
  embeddings (sqlite-vec), deviation/question taxonomies, entity linking
- **Both backends**: devin CLI + aider/OpenRouter, capability-flagged
- **Secondary channels** (always available alongside the UI): doc
  approval via real PRs on the tickets repo; Q&A via `## Triage`
  checklists — github.com flows work for humans who never open the app

## OUT — v1 (deferred, designed-for)

- Jira / Linear importers (importer contract is ready; GitHub ships)
- Headless daemon deployment mode (engine is built for it)
- Remote embedding providers; analytics/support-ticket connectors;
  incremental update-on-merge (manual + cron refresh is v1)
- Per-stage model routing (config seam exists: main_model/review_model)
- Assignment/roles on shared queue (claims + attribution ship; roles later)
- OS-keychain secrets (.env is v1; keychain is a hardening tier)
- Whisper-class voice (webview speech API is the v1 path — shell-dependent)
- Voice-driven workflows beyond text-field dictation

## Pilot plan (informs tuning — explicitly NOT a build gate)

Run ≥3 real tickets through the pipeline end-to-end. Record
(observed in events.jsonl): tickets→PR rate, human-minutes/ticket,
cost/ticket, failure stages, reviewer FP/churn rate, deviation rate
(headline spec-quality metric), spec-score trend.
