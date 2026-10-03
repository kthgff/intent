---
id: EX-001
title: Add retry logic to ingestion worker
status: todo
priority: high
repo: backend
---

## Description

The ingestion worker dies silently on transient database errors (deadlocks,
connection resets). Wrap the write path in retry logic so transient failures
recover without operator intervention.

## Acceptance criteria

- [ ] Transient errors (deadlock, conn reset) retry up to 3 times with
      exponential backoff + jitter
- [ ] Non-transient / exhausted failures land in the `dead_letter` table with
      the original payload and error
- [ ] Table-driven tests cover: retry-then-succeed, retry-then-dead-letter,
      non-transient-immediate-dead-letter

## Notes

Worker lives in `internal/etl/worker.go`. Error classification helpers exist
in `internal/db/errors.go`. See ADR-004 for the backoff policy.
