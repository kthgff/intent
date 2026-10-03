---
schema: 1
id: SR-0003
title: Add /healthz endpoint
status: ready
priority: low
repos: [code-repo]
depth: light
---

## Description
Add a `GET /healthz` returning 200 + `{"ok": true}` for liveness probes.

## Acceptance criteria
- [ ] `GET /healthz` returns 200 JSON `{"ok": true}` without auth
- [ ] Covered by a test carrying marker `case:c1`

## Notes
Fixture ticket — triage complete, ready for prd-draft.
