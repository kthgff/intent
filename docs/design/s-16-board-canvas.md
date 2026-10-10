# S-16 — Board canvas

Design doc companion to `UI-INVENTORY.md` §2 + `FEATURES.md` §2.
Status: draft 2026-10-04; Miro-inspired canvas refinement proposed
2026-10-06 in [`BOARD-CANVAS-TDD.md`](BOARD-CANVAS-TDD.md). Stack:
React+Vite · React Flow 12 (binding `ARCHITECTURE.md` decision). Style:
Linear-inspired app
chrome; canvas layer = Miro/FigJam visual language (color, paper,
soft shadows) — the two palettes deliberately contrast: chrome is
machine, canvas is human.

Purpose: the idea space — capture (WF-18), synthesize (WF-19), and
the kanban delivery view tracking spawned work (WF-20). THE front
door of idea→production.

**Two boards, one component (D21 + D26):** the delivery view IS the
S-01 pipeline board (`s-01-board.md`) — same kanban component, same
5 phase columns (Backlog·Spec·Build·Review·Done), same attention
badges and validated drop targets — scoped by this board's saved
filter instead of project-wide. S-01 Home = every project's work;
S-16 delivery = the work this idea board spawned.

## Layout — idea mode

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ Q1 goals — myApp   ⌘K    [Idea | Delivery]   [Synthesize] [filter⚙][1] │
├──────┬───────────────────────────────────────────────────────────────────┤
│      │                                                                   │
│ 📝   │   ╭─ ZONE: onboarding ───────────────────────────╮   [voice-note] │
│ 🗎   │   │ 🟨 thought: "users skip step 3"              │  ╭──────────╮  │
│ 🖼   │   │ 🟩 goal: "activation ≥60%"      ~agent:survey │  │ 🎙 0:32   │  │
│ 📎   │   │ 🟥 req: "SSO must be optional"               │  │ voice    │  │
│ 🔗   │   │ [image: current-activation.png]              │  ╰──────────╯  │
│  [2] │   │ 📄 RFC — new pricing (doc, 12pg)             │               │
│      │   ╰──────────────────────────────────────────────╯               │
│      │        ⋯consumed (dimmed) 🟨 "SSO?" —consumed→IN-7·ac3   [3]      │
│      │                                                                   │
│      │   ╭─ ICEBOX ──╮                                    ╭─ ZONE: ──╮  │
│      │   │ 🟨 parked │                                    │ 🟩 done  │  │
│      │   ╰───────────╯                                    ╰──────────╯  │
│      │                                                                   │
│      │        pan/zoom · select · dbl-click = new sticky           [4]   │
└──────┴───────────────────────────────────────────────────────────────────┘
```

## Layout — delivery mode (toggle)

```
│ ◆ Q1 goals — myApp      [Idea | ▣Delivery]   filter: IN-7 + orphans ⚙ │
├────────────────────────────────────────────────────────────────────────┤
│ SPEC'ING        IMPLEMENTING      REVIEWING          DONE              │
│ ┌───────────┐  ┌───────────┐   ┌───────────┐    ┌───────────┐  [5]    │
│ │FE-3 Cards │  │SR-1142 ●  │   │SR-1138 ○  │    │SR-1101 ✓  │         │
│ │feature    │  │SR-1143 ■  │   │           │    │           │         │
│ └───────────┘  └───────────┘   └───────────┘    └───────────┘         │
│ (● blocked / ■ running / ○ gate / ✓ merged — full actions per card)    │
└────────────────────────────────────────────────────────────────────────┘
```

## Annotations

1. **Header** — board name · project · mode toggle (Idea | Delivery) ·
   **Synthesize** split-button (primary CTA; default = "new since last
   run", menu: entire board / zone / selection / tray) · filter gear
   (saved filter config: project / initiative / feature / status /
   priority / orphans).
2. **Tool rail** — sticky, text, image, file, link, voice, zone,
   connector; drag or click-to-place.
3. **Item states** — open (full color) · consumed (dimmed, frozen,
   badge links to produced artifacts "→IN-7·ac3") · shipped (lit
   accent, glow) · parked (icebox zone) · superseded (struck, links
   replacement). `~agent:<run>` source chip on agent-added items.
4. **Canvas surface** — pan/zoom, marquee select, dbl-click creates a
   sticky at cursor, drag-connect items, zones are resizeable labeled
   frames; comments thread on any item. The white surface has major grid
   lines every 96 canvas pixels, subdivided into four rows and four
   columns by lighter lines every 24 pixels. Both grid layers remain
   transparent so the major grid cannot obscure the subdivisions;
   minor lines fade below 0.6× zoom and disappear at 0.25× to avoid moiré.
5. **Delivery view** — the shared pipeline-board kanban (5 phase
   columns, per `s-01-board.md`), scoped by the board's saved filter.
   Cards = live ticket/feature objects with **full actions** (open
   gate → wizard/doc-review, approve, retry, claim — same idempotent
   actions + `drop_targets` as inbox/board). Card click → S-05/S-17.

## Item types (all LLM-context — FEATURES.md §2.1)

| Item | Card anatomy | Ingest |
| --- | --- | --- |
| sticky | color + type chip + text | direct |
| text card | prose block | direct |
| document | title + page count + preview | markdown/text extract |
| image | thumbnail + caption | vision/OCR at synthesis |
| file | name + type + size | text extract |
| link | favicon + title + snippet | fetched to markdown on save |
| voice note | duration + play + transcript | transcribed on ingest |
| zone | labeled frame (bounds) | topology = grouping hint |
| connector | arrow + optional label | relationship hint |
| comment | thread on any item | discussion context |

## Synthesize flow

`Synthesize ▾` → scope pick (board/zone/selection/new-since-last-run/
tray) → confirm with **cost preview** ("extract 14 open items across 2
zones — icebox excluded — ~$2–4 on sonnet") → `board-synthesize` run
→ S-04 wizard (≤15 questions; overflow → PRD `Open questions`) →
initiative `prd.md` draft + `provenance.json` → S-06 review →
initiative exists; consumed items freeze+dim; delivery view fills with
the spawned tree; card navigates to S-18 initiative detail.

## Capture tray dock

A collapsible bottom strip on the canvas (D27): untriaged captures
(`board: null` items from `veto add`, `⌘⇧C`, `POST /capture`,
mobile) — drag up onto the canvas, right-click to type/park, or leave
for a `tray`-scoped synthesis run. Sidebar tray icon + count mirrors
mail-inbox behavior; `feedback` items land here tagged to their
shipped entity.

## Fields

| Element | Source |
| --- | --- |
| Item | `board_items` row (kind, type, content jsonb, x/y/w/h, source, status) |
| Zones | `board_items` kind=zone; icebox = well-known zone |
| Filter | `boards.filter_config` |
| Work cards | `tickets`/`features` projections scoped by filter |
| Provenance | `produced_refs` on items ↔ `provenance.json` |

## Interactions

- Autosave on every mutation; undo/redo within session.
- `n` new sticky, `v` voice note, `z` zone, `1-6` sticky colors,
  `Space` pan, `⌘scroll` zoom, `del` delete (consumed = supersede-only).
- Right-click item → type chip, source info, produced-links, park,
  supersede.
- Card actions (delivery view) reuse the gate surfaces — embedded
  wizard/doc-review panels or route-through.

## Style notes

- Canvas is theme-aware: soft neutral gray "paper" in light mode and
  warm zinc-925 in dark mode. A note type supplies its initial color;
  users may override it while the authoritative type chip remains.
  Stickies use the classic six-color palette with restrained shadows.
- Kanban columns zinc-900 headers, cards same anatomy as inbox rows.
- Synthesize button: indigo primary, item-count suffix.
