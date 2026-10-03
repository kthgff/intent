---
id: EX-002
title: Unread-notifications badge in nav bar
status: todo
priority: medium
repo: frontend
model: fast
---

## Description

Add an unread-count badge to the notifications bell in the top nav. The count
comes from `GET /api/notifications/unread-count` (already deployed). Poll
every 60s; no websockets in this ticket.

## Acceptance criteria

- [ ] Bell icon shows a badge with the unread count (hidden when 0, "9+" cap)
- [ ] Count refetches every 60s and on window focus
- [ ] Component test covers badge render states

## Notes

Nav bar lives in `src/components/AppNav.tsx`. Use the existing
`usePoll` hook in `src/hooks/` — do not write raw `setInterval`.
