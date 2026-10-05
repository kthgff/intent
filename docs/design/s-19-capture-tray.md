# S-19 — Quick Capture + Project Tray

Design doc companion to `UI-INVENTORY.md` WF-21 and `FEATURES.md` §2.1.
Status: inventory-complete, visual design pending 2026-10-04.

Purpose: make capturing an idea or production signal faster than deciding where
it belongs. `/capture` is a minimal, mobile-safe ingress page; `/tray` is the
project inbox for routing, refining, or synthesizing untriaged items. The global
`⌘⇧C` modal is the compact form of the same component.

## `/capture` page

- One primary input: text, voice, link, image, or file.
- Project defaults to the current/recent project and remains changeable.
- Destination defaults to **Tray**; an existing board can be chosen without
  opening the canvas.
- Type is guessed (`thought`, `goal`, `ambition`, `question`, `requirement`,
  `reference`, `feedback`) and can be corrected with one tap.
- Feedback mode can link the capture to an Initiative, Feature, or Ticket.
- Save immediately; show durable confirmation, retry/offline state, and a
  follow-up action to add another or open the destination.
- No required categorization beyond content + project. Capture must never turn
  into an interview.

## `/tray` page

- Project-scoped list/grid of `board_items` where `board` is null.
- Search and filters: type, source, age/stale, related subject, ingest state,
  attachment kind, selected/unselected.
- Preview/inspector: full content, transcript/extract status, source, related
  object, created/touched timestamps, edit type/content, supersede history.
- Actions: move or drag to a board/zone, move to icebox, choose related subject,
  delete an unconsumed mistake, supersede an auditable item, bulk move, and
  create a new board from selection.
- Synthesize selected or the whole tray with the standard scope/context/cost
  preview, then continue through S-04 and S-06.
- Failed link/file/transcription ingest stays visible with retry; it is never
  silently excluded from synthesis.

## Shared compact modal

`⌘⇧C` and `⌘K → Capture` open the same input in an overlay: content, inferred
type, project, board-or-tray, optional related subject, Save. Successful capture
closes the modal and leaves an Undo/Open toast.

## Data and routes

| Surface | Contract |
| --- | --- |
| Create | `POST /capture` → `board_items` row (`board: null` or selected board) |
| Tray list | `GET /capture?project=<id>&board=null` (final route name may be `/tray`) |
| Update/move | item mutation endpoint with optimistic version/conflict check |
| File/link/voice ingest | background run + artifact/extract status on the item |
| Synthesize | standard `board-synthesize` request with `scope: tray|selection` |

## Required states

New/empty · populated · filtered-empty · saving · saved · offline/retry · ingest
running · ingest failed · stale conflict · bulk selected · moved · consumed by
synthesis. Keyboard, touch, and screen-reader flows are first-class; `/capture`
must work at narrow mobile widths without loading the canvas runtime.
