# S-05 — Ticket focus page (the operational hub)

Design doc companion to `UI-INVENTORY.md` §2. Status: reviewed 2026-10-04.
**Supersedes `s-05-ticket-detail.md` and the D24 layout.** The focus page is
the ticket page: `/tickets/<ref>` routes here from every board card, Inbox row,
and gate item. Stack: React + Vite · Tailwind · shadcn/ui (Radix).

Purpose: give an operator one place to understand what is happening, complete
the immediate action, and work the ticket through documentation, development,
code review, and release. The first question the page answers is **what happens
next?** The second is **what remains after that?**

## Layout

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ← Board   SR-0142 — Session cache backend  [Documentation · needs-info]│
│           team-a · P1 · updated 2h ago            [Run monitor][Ledger]│
│ ┌──────────────────────────────────────────────┐ ┌───────────────────┐│
│ │ NEXT ACTION — waiting on you · Q&A           │ │ STATUS            ││
│ │ Which cache backend…? A / B / C ★ rec        │ │ Documentation     ││
│ │ [Answer] [Skip = accept recommendation]      │ │ Waiting on you    ││
│ ├──────────────────────────────────────────────┤ ├───────────────────┤│
│ │ [Overview][Documentation][Activity][Runs]    │ │ WHAT'S LEFT       ││
│ │                                              │ │ ✓ Ticket          ││
│ │ Ticket definition / selected work surface    │ │ ● Product reqs    ││
│ │ AI appears here only while editing ticket.md │ │ ○ Technical design││
│ │ or a selected document.                      │ │ ○ Test plan       ││
│ │                                              │ │ ○ Implementation  ││
│ │                                              │ │ ○ Code review     ││
│ └──────────────────────────────────────────────┘ ├───────────────────┤│
│                                                  │ KEY FACTS         ││
│                                                  └───────────────────┘│
└───────────────────────────────────────────────────────────────────────┘
```

This is a two-column page: one wide workbench and one narrow status rail. There
is no permanent assistant column and no horizontal phase strip.

## Information hierarchy

1. **Ticket header** — back link, ticket identity, one status badge, priority,
   update age, and direct links to the run monitor and full ledger. The badge
   combines the human phase label with the exact conductor sub-status.
   **Lineage breadcrumb** (D26): when the ticket has a `feature:` parent,
   the header shows `IN-7 › FE-3 › SR-0142` — initiative and feature names
   link to S-17 (feature detail) and the board; orphans show no breadcrumb.
   Board provenance (which sticky/idea the ticket descends from, via
   `provenance.json`) surfaces as a `from board ▸` link in Key facts.
2. **Next action** — the immediate action is always at the top of the main
   workbench and can be completed without leaving the page. It shows who owns
   the move: `Waiting on you`, `Veto is working`, or `No action needed`.
3. **Workbench** — `Overview · Documentation · Activity · Runs`, plus one
   status-conditional spotlight tab when relevant: `Code review` (the full S-08
   surface), `Failure`, or `Split plan`.
4. **Status rail** — one current phase, one explicit next-step sentence, then a
   vertical **What's left** roadmap. The roadmap is explanatory, not another
   navigation control or a status editor.
5. **Key facts** — project, priority, spec score, branch, and (when set)
   feature/initiative lineage + board provenance stay available below the
   roadmap.

## Next-action states

| State | Owner label | Inline completion |
| --- | --- | --- |
| Agent question | Waiting on you · Q&A | Choose/enter an answer and submit |
| Document approval | Waiting on you · approval | Review, approve, or request changes |
| Code finding | Waiting on you · code review | Comment, dismiss, send to fix, or approve |
| Failure/blocked | Recovery required | Retry, edit and retry, or won't-do |
| Verify (D27) | Waiting on you · verify | `verify-confirm` — confirm released / mark failed; or live `verifying` run card (verify_cmd / app_url smoke) |
| Active run | Veto is working | Show stage, progress, last activity, and Watch run |
| Terminal | No action needed | Show completed outcome and audit links (`released` shows verify evidence) |

The next-action panel contains only the current move. Future work belongs in the
roadmap, so the user does not have to separate one decision from a pipeline of
possible later decisions.

## Workbench

- **Overview** — rendered `ticket.md`, spec score, repositories, branch, spec
  package, and recent evidence. `Edit` and `Improve with AI` are contextual
  actions on this surface.
- **Documentation** — versioned PRD/TDD/test selectors, selected document,
  rendered/edit view, history, and MR-style version diffs. Every persisted
  change is a version, whether produced by an agent or a person.
- **Activity** — the full S-11 ledger embedded, including actors, events, and
  per-run artifacts.
- **Runs** — engine, model, state, usage, and links to S-07.
- **Code review** — full review brief, code diff, findings, inline comments,
  test evidence, code changes, and disposition actions. It is a work surface,
  not a summary card.
- **Failure / Split plan** — status-specific evidence and actions in the same
  main work area.

## Contextual AI

AI is an editing capability, not page chrome. It appears only beside the object
the operator is changing:

- on `ticket.md`, `Improve with AI` opens an inline edit composer;
- on PRD/TDD/test, the selected document ends with a `Revise with Veto`
  composer;
- in code review, AI actions are attached to a selected finding, comment, or
  requested code change.

Every AI edit is ticket-scoped and multi-turn. The flow is prompt → proposed
diff → human approve/discard → commit → ledger event → version bump. Nothing is
persisted merely because the assistant generated it. There is no assistant in
the right rail or on non-editing tabs.

## Roadmap derivation

The UI derives the current roadmap position from server-owned ticket status; it
does not create a second transition model:

`Ticket definition → Product requirements → Technical design → Test plan → Implementation → Code review → Merge → Verify → Released`

Completed milestones use a check, the current milestone gets the sole active
emphasis, and later milestones remain quiet. Only the current and immediately
next milestone need explanatory copy. Failed/blocked tickets retain their last
meaningful milestone and layer the recovery state onto it.

## Data

| Surface | Source |
| --- | --- |
| Header/status/roadmap | ticket projection + server-derived `phase` |
| Next action | current open `gate_item`, active run, or terminal outcome |
| Docs + versions | `GET /tickets/<ref>/docs/<name>` |
| Activity | `GET /tickets/<ref>/events` |
| Runs | `GET /runs?ticket=<ref>` |
| Code review | proposed `GET /tickets/<ref>/review` |
| Contextual AI edit | `POST /interview` with `ticket_ref` + `target`; approve endpoint commits, emits `doc_edited`, and bumps version |

## Interaction and responsive rules

- All actions are keyboard reachable; status and owner use text, not color
  alone. Live SSE updates do not steal focus or reset the active tab.
- The main workbench remains first in source order. At narrow widths the status
  rail stacks after it.
- Document selectors become a horizontal or wrapped row; the AI composer stays
  inside the selected document panel rather than becoming another column.
- The board is unchanged by this revision. Returning to Board should restore
  its project, filter, and scroll context.

## Explicitly removed from the D24 layout

- horizontal `Backlog · Spec · Build · Review · Done` strip;
- permanent right-rail AI assistant;
- separate Surfaces link panel duplicating the tabs and header actions;
- the label `Your move` when the agent, rather than the person, owns the next
  step.
