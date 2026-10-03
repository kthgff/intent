---
schema: 1
id: wp-013
title: Ticket projection — frontmatter scan → tickets/ticket_repos rows
status: donepriority: high
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
- [x] Fixture tickets repo → correct projection rows (test)
- [x] Malformed frontmatter → gate_items failure row, others still project
- [x] Re-run is idempotent; deleted ticket dirs remove rows
- [x] Status transitions never written here — read-only projection

## Decisions (implemented)
- Location: `packages/conductor/src/projection/` (per task; EXEC-PLAN
  alternative `packages/tickets/` not taken — projection is a conductor
  reconcile-step concern).
- Fixtures omit `depth`/`depends_on`/`forced`; SCHEMAS §1 documents
  their defaults inline, so `parseTicketFile` applies those defaults
  (`standard`/`[]`/`false`) before `TicketFrontmatterSchema` validation.
  Present-but-invalid values remain fail-closed errors.
- `gate_items` has no detail column (DB-SCHEMA): parse failures write a
  `failure` item (gate `ticket-parse`, subject = ticket dir name,
  blocked_agent) plus a notifications row whose payload carries the
  error detail.
- `spec_hash` = sha256 of ticket.md contents (spec-doc inputs land in a
  later wp, per task).
- `ticket_repos`: frontmatter carries no branch/worktree/pr/ci, so
  re-projection preserves the existing row's run-state fields
  (null-guard); rows for repos no longer in `repos[]` are dropped.
