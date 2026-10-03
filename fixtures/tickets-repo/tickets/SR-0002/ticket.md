---
schema: 1
id: SR-0002
title: Notifications badge on the app icon
status: needs-info
priority: medium
repos: [code-repo]
---

## Description
Show a dock/badge count of needs-attention inbox items.

## Acceptance criteria
- [ ] Badge count equals open gate_items for the active workspace

## Triage
- [ ] Which event source drives badge updates — SSE stream or 30s poll?
      (recommended: SSE `gate_surfaced`/`gate_cleared`, per API.md)
- [ ] Should badge persist when the app window is closed?
      (recommended: yes — dock badge reflects the daemon's state)

## Notes
Fixture ticket — mid Q&A; answers not yet committed.
