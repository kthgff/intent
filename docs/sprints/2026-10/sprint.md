# Sprint 2026-10

Sprint goal: harden the job-ingestion pipeline and ship the first cut of the
candidate-facing notifications MVP.

Shared context for every ticket in this sprint:

- Backend is Go 1.23 (chi + sqlc). Keep handlers thin; business logic lives in
  `internal/service/`.
- Frontend is React 19 + Vite + TypeScript, strict mode. No new runtime deps
  without an ADR.
- Migrations must be reversible (`up`/`down` pairs) and named
  `YYYYMMDDHHMM_<slug>`.
- Prefer table-driven tests; CI runs `make verify` (lint + typecheck + tests).
