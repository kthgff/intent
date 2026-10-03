---
schema: 1
id: wp-013
title: Ticket projection — frontmatter scan → tickets/ticket_repos rows
status: in-progress
priority: high
depth: standard
repos: []
wave: W1
depends_on: [wp-010, wp-011, wp-012]
---

## Description
After each tickets-repo pull, scan `tickets/*/ticket.md`, parse
frontmatter via core zod schema, upsert `tickets` projection rows +
`ticket_repos` rows (one per `repos:` entry). Malformed tickets →
`failure` inbox item, never a crash. Compute `spec_hash` inputs per
DB-SCHEMA. Expose `projectTickets(repoPath, store)`.

## File ownership
`packages/conductor/src/projection/**` (or `packages/tickets/**` —
pick per EXEC-PLAN layout and document)

## Acceptance criteria
- [ ] Fixture tickets repo → correct projection rows (test)
- [ ] Malformed frontmatter → gate_items failure row, others still project
- [ ] Re-run is idempotent; deleted ticket dirs remove rows
- [ ] Status transitions never written here — read-only projection
