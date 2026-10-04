# S-16 — Board canvas

Design doc companion to `UI-INVENTORY.md` §2 + `FEATURES.md` §2.
Status: draft 2026-10-04. Stack: React+Vite · Tailwind · shadcn/ui ·
canvas impl TBD (tldraw SDK recommended). Style: Linear-inspired app
chrome; canvas layer = Miro/FigJam visual language (color, paper,
soft shadows) — the two palettes deliberately contrast: chrome is
machine, canvas is human.

Purpose: the idea space — capture (WF-18), synthesize (WF-19), and
the kanban delivery view tracking spawned work (WF-20). THE front
door of idea→production.

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
   **Synthesize** (primary CTA, shows open-item count) · filter gear
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
   frames; comments thread on any item.
5. **Delivery view** — kanban columns by status group; cards = live
   ticket/feature objects with **full actions** (open gate → wizard/
   doc-review, approve, retry, claim — same idempotent actions as
   inbox). Card click → S-05/S-17.

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

`Synthesize` → confirm ("extract 14 open items across 2 zones —
icebox excluded") → `board-synthesize` run → S-04 wizard for
ambiguities → initiative `prd.md` draft + `provenance.json` → S-06
review → initiative exists; consumed items freeze+dim; delivery view
fills with the spawned tree.

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

- Canvas bg warm zinc-925 (slightly lighter than app chrome) — the
  "paper" zone; stickies: classic 6 (yellow/pink/blue/green/orange/
  purple) with soft shadow + slight rotation.
- Kanban columns zinc-900 headers, cards same anatomy as inbox rows.
- Synthesize button: indigo primary, item-count suffix.
