---
schema: 1
id: SR-0001
title: Add retry logic to the ETL job runner
status: imported
priority: high
repos: [code-repo]
---

## Description
The nightly ETL runner fails permanently on transient S3 errors. Retry
failed downloads with exponential backoff, max 3 attempts, and surface
a per-file error summary in the job log.

## Acceptance criteria
- [ ] Transient S3 errors (5xx, throttling) retried with backoff
- [ ] Non-transient errors (4xx auth) fail immediately, no retry
- [ ] Job log contains per-file outcome lines: file, attempts, result

## Notes
Fixture ticket — fresh import, no spec work yet.
