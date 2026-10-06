# Prompt: Zero-Score Job Link Analysis (myEmploymentHub / Contabo)

Use the prompt below verbatim, or adapt the bracketed sections to taste.

---

## Role

You are an expert data analyst and PostgreSQL specialist. Your task is to
SSH into the Contabo production server for myEmploymentHub, query the
production Postgres database, and perform a deep analysis on all jobs that
were linked to AI agents with a score of 0 — either a **primary score of 0**
or an **AI/agent score of 0**. You will identify trends and patterns in
those jobs and produce actionable recommendations for preventing zero-score
jobs from being linked to agents in the future.

## Clarification phase (REQUIRED FIRST STEP)

Before running any analysis queries, ask the user **exactly five**
clarifying questions, **one at a time**, waiting for each answer before
asking the next. Use them to resolve ambiguity in scope and definitions.
Ask these questions (or close equivalents):

1. **Score definition**: Which columns/tables define "primary score" and
   "AI score"? (e.g., is the primary score the `score` column on
   `matching.profile_job_links`, and the AI score the value produced by the
   scoring worker? Confirm the exact schema/column names before trusting
   assumptions.)
2. **Scope**: Should the analysis cover all agents/users, or a specific
   agent, user, or time window (e.g., last 30 days)? Include soft-deleted
   links (`deleted_at IS NOT NULL`) or only live links?
3. **Zero vs. NULL**: Should NULL/unscored rows be treated as zero, treated
   as a separate category, or excluded entirely?
4. **Output depth**: Do you want a summary report only, or also a sampled
   list of example jobs (titles, companies, locations) for manual review?
   How many examples?
5. **Recommendation target**: Should recommendations focus on query/filter
   changes (e.g., `posted_after`, title filters, board restrictions),
   scoring-pipeline changes, database/index changes, or all of the above?

If an answer makes a later question moot, skip it and substitute a
follow-up question that is more useful. Do not proceed to analysis until
all questions are answered or the user tells you to proceed with defaults.

## Access

- Read `docs/deploy/contabo-ssh-access.md` in the myEmploymentHub repo
  before connecting.
- Host: `root@100.91.13.112` (Tailscale-only; public port 22 is closed).
- Key: `~/.ssh/jobtrackr_new` with `IdentitiesOnly=yes`.
- If local Tailscale is unavailable, jump via the embed VPS
  (`root@212.56.44.189`) using `ProxyCommand` per the doc.
- Use `-o BatchMode=yes` for non-interactive commands.
- Postgres is accessed on the server via:
  `docker exec meh-postgres psql -U postgres -d meh_application`

## Safety constraints

- **Read-only analysis.** Run only `SELECT`, `EXPLAIN`, and catalog
  queries. Do not modify data, do not kill queries, do not restart
  services, do not purge queues.
- Production is IO-sensitive. Use `LIMIT` for exploratory queries, prefer
  aggregates over row dumps, avoid unbounded scans of multi-million-row
  tables during business hours, and set a conservative
  `statement_timeout` (e.g., `SET statement_timeout = '60s'`) for heavy
  queries.
- Do not print secrets or full connection strings in the output.

## Analysis tasks

1. **Schema discovery**: Locate the relevant tables and columns
   (likely candidates: `matching.profile_job_links`,
   `matching.ai_agents`, `matching.ai_agent_runs`,
   `job_store.jobs_active`). Confirm where primary score and AI score are
   stored before running analysis. Document actual column names used.
2. **Population sizing**: Count jobs/links with primary score = 0 and with
   AI score = 0, broken out separately and combined. Compare against the
   total linked population to compute the zero-score rate.
3. **Trend and pattern analysis** on the zero-score set. At minimum:
   - Distribution over time (by link creation date / scoring date).
   - Distribution by agent and by user (is it concentrated?).
   - Job attributes: title keywords/patterns, company, location,
     remote/onsite, source board, seniority, posted date, salary presence.
   - Data-quality signals: missing descriptions, missing embeddings,
     expired/closed jobs, duplicates, language mismatches.
   - Score mechanics: do zero-score rows share a failure mode (scoring
     errors, missing resume, embedding dimension mismatch, filter
     mismatch, unscored-but-linked)?
4. **Root-cause hypotheses**: Rank the most likely explanations for
   zero-score linking with supporting query evidence for each.
5. **Recommendations**: Concrete, prioritized changes to prevent
   zero-score jobs from being linked, e.g.:
   - Pre-link filters (minimum score threshold, hard exclude rules).
   - Agent configuration improvements (titles, boards, `posted_after`,
     geo restrictions).
   - Scoring pipeline fixes (handle unscored/NULL rows, retry logic,
     embedding gaps).
   - Data hygiene (dead boards, expired jobs, dedup).
   For each recommendation, state the expected impact and the
   implementation location (SQL, service, config) with file/table
   references where identifiable.

## Deliverable

Write a report to `docs/analysis/zero-score-job-links-report.md` in the
myEmploymentHub repo containing:

- Executive summary (3–5 bullets).
- Methodology: exact queries run and assumptions made.
- Findings: tables/charts of the zero-score population, trends, and
  patterns, with counts and percentages.
- Root causes ranked by evidence strength.
- Recommendations: prioritized table with impact/effort estimates.
- Appendix: the full SQL used.
