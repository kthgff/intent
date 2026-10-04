# S-14 — Knowledge base

Design doc companion to `UI-INVENTORY.md` §2. Status: draft 2026-10-03.
Stack: React+Vite · Tailwind · shadcn/ui (Radix). Style: Linear-inspired —
dark-first, dense (13px base), minimal chrome.

Purpose: the intelligence layer (WF-16, WF-17) — product dossiers
surfaced for humans: browse sections, review the gap report, correct
wrong facts, confirm inferred personas, trigger re-surveys. Corrections
are DB writes + ledger events — the human disposes, the agent proposes.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ sprint-runner   ⌘K                                                     │
├────────────┬──────────────┬───────────────────────────────┬──────────────┤
│            │              │                               │              │
│  SIDEBAR   │  KB          │  backend · dossier v4         │  SYNC   [4]  │
│            │  ────────────│  surveyed 3d ago · code,docs  │ ┌──────────┐ │
│  Inbox   9 │  PRODUCTS    │ ─────────────────────────────  │ │surveyed  │ │
│  Tickets   │  ▾ myApp     │  ## Architecture map           │ │3d ago    │ │
│  Review  2 │    backend●  │  ┌──────────────────────────┐  │ │sources:  │ │
│  Queue   1 │    frontend  │  │ modules…data flow…  [5]  │  │ │code,docs │ │
│  Escal.  2 │  REPOS       │  └──────────────────────────┘  │ │shots,crwl│ │
│  Metrics   │  ▾ backend   │  ## Personas                 │ │          │ │
│  KB        │    arch ●    │  | name | kind | evidence |   │ │[Sync now]│ │
│            │    domain    │  | oncall-eng | inferred|…|✎?│ │[Schedule▾│ │
│            │    workflows │     confirm? [yes][rename][no] │ │  weekly] │ │
│            │    personas  │            [3]                 │ └──────────┘ │
│            │    ui-map    │  ## Gap report               │              │
│            │    gaps   4● │  | gap | kind | sev |         │  ENTITIES    │
│            │              │  | password reset flow |      │ ──────────── │
│            │              │  | undocumented-workflow|high││ Session    │
│            │              │         [2]                   ││ CachePolicy│
│            │              │                               ││ (12 linked)│
└────────────┴──────────────┴───────────────────────────────┴──────────────┘
                                     [1]
```

## Annotations

1. **Section nav** — second rail: product tabs → repos → dossier
   sections (architecture, domain-model, workflows, personas, docs,
   ui-map, glossary, landmines, gap-report). Dots mark `stale`
   sections and unseen gaps (● count).
2. **Gap report** — table per SCHEMAS §11: gap, kind
   (undocumented-workflow / doc-vs-code-contradiction / untested-flow /
   doc-rot / dead-screen / missing-persona-info), evidence link,
   severity. Row actions: file-as-ticket (→ S-03 interview seed),
   dismiss.
3. **Persona confirmation** — inferred entities render a
   confirm/rename/reject inline bar (sets `source: confirmed` on the
   entity). Unconfirmed = amber `inferred` chip; confirmed = green.
4. **Survey card** — last surveyed, sources used, **Sync now** (survey
   run → watch in S-07), schedule picker (`survey.refresh`).
5. **Section body** — rendered dossier markdown (tables render as
   tables). Per-section **edit** pencil → inline markdown editor →
   save writes `version+1`, `edited_by` — with per-section version
   history dropdown + diff (human version wins on re-survey conflict,
   flagged for review per DB-SCHEMA).

## Fields

| Element | Source |
| --- | --- |
| Section list | `dossiers` rows: scope, name, section, version, stale |
| Body | `dossiers.content` markdown, `surveyed_at`, `sources_used` |
| Personas | `entities` kind=persona, `source` inferred/confirmed, evidence |
| Gaps | `gap_report` table in dossier + `gap_reported` events |
| Entities rail | `entities`/`relations` linked to the ticket at hand or section |

## Interactions

- Correct-anywhere: select text → "correct" → edit box → becomes a
  `dossier_edited` event + human version.
- `stale` badge → click shows what the refresh diff flagged.
- Survey failure → notification + inline `SURVEY-FAILED` banner w/
  retry.
- Search box in section rail (canonical names + aliases via entities).

## Style notes

- Three-rail layout like S-05 (nav / content / context) — consistent
  anatomy for "browse a knowledge object" screens.
- Confirmed vs inferred is the key visual axis: inferred items always
  amber-flagged until a human touches them.
- Editor: same markdown+frontmatter component as ticket editing.
