# UI polish — audit and implementation proposal

Status: **Phase 1 proposal — awaiting approval**  
Date: 2026-10-08  
Scope: the production UI in `packages/ui`; `packages/ui/src/demo/` is excluded.

This proposal covers all 25 production screen modules, the shared component
layer, and the board canvas. It is ordered by impact per effort. Phase 2 must
begin with the shared foundation, then proceed in five reviewable batches of
five screens each.

## Direction

The recommended direction is a **calm technical instrument panel**: dense and
precise, with enough surface depth and semantic color to make hierarchy obvious
without becoming decorative. Light and dark are equal products. Dark should
feel deep rather than black and border-heavy; light should feel crisp rather
than washed out. Both use the same spacing, elevation, typography, and state
vocabulary.

This is a noticeable refresh outside the idea board. The idea board is already
close to the intended product quality, so its spatial layout, paper surface,
sticky-note palette, and chrome placement stay intact. It receives only token
alignment, contrast validation, and small consistency fixes.

## Audit evidence

- Read the complete 3,584-line stylesheet, shared components, every file in
  `packages/ui/src/screens/`, and the rendering/UI modules in
  `packages/ui/src/board-canvas/`. Files:
  `packages/ui/src/styles.css`, `packages/ui/src/components.tsx`,
  `packages/ui/src/screens/*.tsx`, `packages/ui/src/board-canvas/*`,
  `packages/ui/src/App.tsx`, and `packages/ui/src/project.tsx`.
- `pnpm -r build` passed. The daemon was already running on
  `http://127.0.0.1:4711`, so a second daemon correctly failed with
  `EADDRINUSE`; the existing instance was used for review. Files/build inputs:
  root `package.json` and `packages/*/package.json`.
- Clicked through and captured 18 representative routes in dark and light at
  1440×1000 with reduced motion enabled. No page-level horizontal overflow was
  detected. Reviewed Projects, Home/Board, Boards, Idea Board, Capture, Tray,
  Create/Import, Discovery, Runs and run detail, Failures, Merge, Releases,
  Knowledge Base, Metrics, Ledger, and Settings. Route ownership:
  `packages/ui/src/App.tsx` and `packages/ui/src/screens/*.tsx`.
- The current theme foregrounds are generally sound: body and muted text exceed
  AA in both themes. The light-theme primary button is not: `#04101f` on
  `#0969da` measures about **3.68:1**, below 4.5:1 for normal text. Files:
  `packages/ui/src/styles.css:1` and `packages/ui/src/styles.css:459`.
- The populated Ticket Focus route could not be visually audited because it
  currently changes hook order between loading and loaded renders. The dev
  build reports “Rendered more hooks than during the previous render” at the
  effect after the early returns. This is a pre-existing functional issue and
  is outside this styling-only work. File:
  `packages/ui/src/screens/TicketFocus.tsx:143`.

## Priority 0 — theme foundation

These changes should land before any screen batch. They improve nearly every
surface and prevent per-screen color and spacing patches.

| Priority | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| P0 | The palette has only background, border, text, accent, and four semantic foregrounds. Screens compensate with raw `rgba(...)`, borders, and fallback values such as `var(--warn-bg, ...)`. | Add a complete per-theme semantic tier: `--surface-1/2/3`, `--surface-hover`, `--border-muted/strong`, `--accent-subtle`, `--success-subtle`, `--warning-subtle`, `--danger-subtle`, `--review-subtle`, and semantic foreground aliases. Keep all color declarations in the theme token blocks. | `packages/ui/src/styles.css:1` | M |
| P0 | Primary button text uses one hardcoded dark ink color in both themes; it fails AA in light mode. | Add per-theme `--accent-contrast`: dark ink for the lighter dark-theme accent and white for the darker light-theme accent. Use it for primary buttons and solid count/status pills. Validate normal-text contrast at 4.5:1 or better. | `packages/ui/src/styles.css:1`, `packages/ui/src/styles.css:443` | S |
| P0 | One heavy `--shadow-1` serves every elevated object; modals have no shadow and many panels rely on borders alone. | Define `--shadow-sm`, `--shadow-md`, and `--shadow-lg` separately for light and dark. Use low elevation for interactive cards, medium for toasts/dropdowns, and high for modals/drawers. Reduce interior borders where elevation or surface contrast already defines a boundary. | `packages/ui/src/styles.css:34`, `packages/ui/src/styles.css:324`, `packages/ui/src/styles.css:689`, `packages/ui/src/styles.css:880` | S |
| P0 | Radius variables exist, but many rules hardcode 4/6/8/10px. The same is true for spacing even though a scale exists. | Normalize controls, cards, panels, badges, and overlays onto `--radius-sm/md/lg` and `--space-1…6`. Preserve compact density; this is a consistency sweep rather than blanket padding growth. | `packages/ui/src/styles.css`, `packages/ui/src/components.tsx`, `packages/ui/src/screens/*.tsx` | M |
| P1 | Hover is usually “turn the border blue,” so hover and selection communicate the same thing. Active/pressed states are sparse. | Make hover a subtle surface shift, reserve accent borders/rings for selection and focus, and add a small pressed-state surface change. Use the existing duration/easing tokens and preserve the global reduced-motion override. | `packages/ui/src/styles.css:76`, `packages/ui/src/styles.css:443`, `packages/ui/src/styles.css:537` | S |
| P1 | The canvas has a separate, polished token layer but duplicates accent, radius, motion, and shadow concepts. | Alias compatible canvas chrome tokens to global tokens while preserving canvas paper, ink, grid, and sticky colors. Keep the canvas selection hue visually aligned with the global accent. Do not change canvas layout or object styling. | `packages/ui/src/styles.css:1488`, `packages/ui/src/board-canvas/BoardCanvas.tsx`, `packages/ui/src/board-canvas/nodes.tsx` | S |
| P2 | Selection highlight and scrollbars use browser defaults, which are conspicuous in the dark theme. | Add theme-tokenized `::selection` and restrained scrollbar styling. Keep native behavior and visible scroll affordance. | `packages/ui/src/styles.css` | S |

## Typography

| Priority | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| P0 | Page titles are styled, but `h2`–`h4` use browser defaults. Screens then repair margins inline, producing uneven section rhythm. | Define a compact heading scale with explicit size, weight, line-height, and margin. Retain 20px page titles; use 16px section headings, 14px subsection headings, and 11px uppercase labels. Remove only the inline margin rules this replaces. | `packages/ui/src/styles.css:180`, `packages/ui/src/screens/Boards.tsx`, `packages/ui/src/screens/DiscoverySession.tsx`, `packages/ui/src/screens/UnderstandingPanel.tsx`, `packages/ui/src/screens/Wizard.tsx` | S |
| P0 | Numeric surfaces use tabular figures inconsistently. Metrics are clear but visually similar to ordinary card text. | Apply tabular numerals to counters, timestamps, token/cost fields, WIP counts, and project stats. Give headline metrics a shared value/label treatment with balanced line-height and tracking. | `packages/ui/src/styles.css:409`, `packages/ui/src/styles.css:596`, `packages/ui/src/screens/Metrics.tsx`, `packages/ui/src/screens/RunMonitor.tsx`, `packages/ui/src/screens/Workspaces.tsx` | S |
| P1 | Navigation groups, `.group-title`, inspector titles, easy-edit titles, and canvas lane labels use five similar small-cap recipes. | Consolidate app-side section labels into one recipe and explicitly document canvas variants. This removes visual drift without making the canvas look like the shell. | `packages/ui/src/styles.css:153`, `packages/ui/src/styles.css:357`, `packages/ui/src/styles.css:2670`, `packages/ui/src/styles.css:3260` | S |
| P1 | Dense prose, markdown, terminal output, and metadata share nearly the same line-height. Long-form content feels compressed while tables occasionally feel loose. | Introduce content-specific line-height tokens: compact for tables/metadata, default for controls, relaxed for markdown/transcripts. Keep monospace at its existing compact size. | `packages/ui/src/styles.css:55`, `packages/ui/src/styles.css:635`, `packages/ui/src/styles.css:669`, `packages/ui/src/styles.css:1150` | S |
| P2 | Keyboard shortcuts render as ordinary monospace text and inline code is only styled inside markdown. | Add a reusable `kbd` treatment and a safe inline-code chip pattern without adding components or dependencies. | `packages/ui/src/styles.css`, `packages/ui/src/App.tsx:364`, `packages/ui/src/components.tsx:376` | S |

## Shared component issues

| Priority | Component / current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| P0 | **Buttons:** the primary button lacks a distinct hover state, destructive hover inherits blue border behavior, and disabled primary buttons become low-contrast. | Establish default, primary, quiet, and destructive button recipes with coherent hover/pressed/disabled states in both themes. Keep minimum target sizes and existing semantics. | `packages/ui/src/styles.css:443`, button call sites in `packages/ui/src/screens/*.tsx` | S |
| P0 | **Badges:** most states are transparent outline pills, giving the application a wireframe quality and making dense status clusters difficult to parse. | Use restrained semantic tints with AA foregrounds and a soft border. Keep solid danger only for the loudest blocking state. Preserve machine/status meaning and casing decisions. | `packages/ui/src/styles.css:211`, `packages/ui/src/components.tsx:132`, `packages/ui/src/screens/Board.tsx`, `packages/ui/src/screens/Inbox.tsx` | M |
| P0 | **Cards and panels:** static and interactive cards look identical; the UI relies on uniform raised rectangles. | Separate static panel, interactive card, selected card, and action-well treatments. Interactive cards gain a one-pixel lift/shadow on hover; static panels remain still. | `packages/ui/src/styles.css:324`, `packages/ui/src/styles.css:1249`, `packages/ui/src/screens/Workspaces.tsx`, `packages/ui/src/screens/MergeCenter.tsx` | S |
| P0 | **Forms:** every input defaults to full width; labels are very quiet; placeholders use UA styling; focus relies entirely on the global ring. | Add compact/standard/long-form field variants, clearer label/value rhythm, tokenized placeholders, accent focus border plus the existing focus ring, and consistent helper/error placement. | `packages/ui/src/styles.css:479`, `packages/ui/src/components.tsx:515`, `packages/ui/src/screens/Settings.tsx`, `packages/ui/src/screens/ReleaseCenter.tsx` | M |
| P1 | **Tabs:** tabs are functional but visually thin, and tab strips become crowded on Settings, Feature, Release, and Knowledge Base. | Increase active-state clarity with surface and underline, add controlled horizontal scrolling for long tab lists, and align inline tabs with page headers. Preserve ARIA roving-tab behavior. | `packages/ui/src/styles.css:537`, `packages/ui/src/components.tsx:174`, `packages/ui/src/screens/Settings.tsx`, `packages/ui/src/screens/FeatureWorkspace.tsx`, `packages/ui/src/screens/ReleaseCenter.tsx`, `packages/ui/src/screens/KnowledgeBase.tsx` | S |
| P1 | **Tables:** headers and rows are separated only by equal-strength rules; long identifiers dominate. | Create dense table tokens for header surface, muted internal dividers, row hover, selected row, numeric alignment, and truncation. Do not zebra-stripe every table; reserve it for very long operational lists. | `packages/ui/src/styles.css:519`, `packages/ui/src/screens/RunMonitor.tsx`, `packages/ui/src/screens/Metrics.tsx`, `packages/ui/src/screens/TicketFocus.tsx`, `packages/ui/src/screens/ReleaseCenter.tsx` | M |
| P1 | **Feedback:** empty states are generic dashed boxes, errors are mostly red text, warnings are outline-only, and loading uses a spinner plus text regardless of surface. | Add shared compact and full empty states, tinted error/warning/success surfaces, and loading variants suitable for page, panel, and inline use. Preserve `role="alert"`, live regions, retry actions, and reduced motion. | `packages/ui/src/components.tsx:17`, `packages/ui/src/styles.css:197`, `packages/ui/src/styles.css:727` | M |
| P1 | **Modal and toast:** modal backdrop is flat, modal elevation is absent, and toasts all use an accent border regardless of meaning. | Apply the elevation ladder, soften/blur the backdrop, add semantic toast tones, and use a short opacity/scale entrance that collapses under reduced motion. | `packages/ui/src/components.tsx:267`, `packages/ui/src/styles.css:689`, `packages/ui/src/styles.css:880` | S |
| P2 | **Inline layout styles:** 83 inline style objects repeat margins, widths, alignment, and max-widths, obscuring the spacing system. | Replace recurring layout-only values with a small set of named classes during each screen batch. Keep computed geometry and React Flow styles inline. Avoid a repository-wide mechanical rewrite. | `packages/ui/src/components.tsx`, `packages/ui/src/screens/*.tsx`, `packages/ui/src/board-canvas/*.tsx` | M |

## Screen batches

The batches below are the Phase 2 unit of review. Shared foundation work lands
first. Each batch contains exactly five screens and should be reviewed and
verified before the next begins.

### Batch 1 — project entry and daily control loop

| Screen | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| Projects | The single card sits in a large empty field; headline stats are useful but visually compressed, and Add Project is detached at the far edge. | Create a stronger page header/action relationship, refine project-card hierarchy, give attention counts semantic tint, and improve responsive grid density without making cards larger. | `packages/ui/src/screens/Workspaces.tsx`, `packages/ui/src/styles.css:369` | M |
| Home | Page title, tabs, capture, filters, and refresh form one loose row. The eye does not clearly choose between view selection and board actions. | Split the header into title/view and action/filters zones, align baselines, and preserve dense one-screen operation. | `packages/ui/src/screens/Home.tsx`, `packages/ui/src/styles.css:537`, `packages/ui/src/styles.css:736` | M |
| Board | Empty lanes are outlined boxes floating on the page; populated cards have weak lane context and their move/snooze controls compete with titles. | Add subtle lane wells, stronger column headers/counts, cleaner card action grouping, and consistent drop/hover states. Keep all drag/drop and keyboard paths unchanged. | `packages/ui/src/screens/Board.tsx`, `packages/ui/src/styles.css:736` | M |
| Inbox | Grouped cards communicate state, but priority, age, blocking status, subject, and actions share one visual level. | Establish a subject-first row, secondary metadata line, right-aligned actions, and stronger blocking/attention treatment through tokens. | `packages/ui/src/screens/Inbox.tsx`, `packages/ui/src/styles.css:1280` | M |
| Boards | Board index, creation form, and discovery-session list look like three equal generic cards. | Make existing boards the primary surface, move creation into a clearly labeled action panel, and render discovery sessions as a compact related list. | `packages/ui/src/screens/Boards.tsx`, `packages/ui/src/styles.css:324` | M |

### Batch 2 — capture and discovery

| Screen | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| Capture | The form works, but the isolated card and emoji-heavy type buttons feel assembled. Destination controls and primary action lack a strong flow. | Treat type as a compact segmented choice, establish textarea → classification → destination → save progression, and reserve room for the later dictation control. | `packages/ui/src/screens/Capture.tsx`, `packages/ui/src/styles.css:1162` | M |
| Tray | Search/filter controls are detached from the item list; selection is only an accent border; the inspector uses a generic card. | Build a compact list toolbar, strengthen selected-row fill and metadata, and give the inspector a consistent detail-panel hierarchy. | `packages/ui/src/screens/Tray.tsx`, `packages/ui/src/styles.css:1084` | M |
| Create / Import | The Interview tab is visually sparse and the textarea spans a wide undifferentiated surface; Import uses dense inline fields. | Use a focused form width, stronger mode explanation, grouped import filters, and clear primary/secondary progression. | `packages/ui/src/screens/CreateImport.tsx`, `packages/ui/src/styles.css:479` | M |
| Discovery Session | The live two-column structure is good, but the question, slot chips, transcript, controls, and readiness panel compete. | Make the active question the primary surface, demote transcript chrome, unify mode controls, and turn readiness text into scannable sections with semantic state surfaces. | `packages/ui/src/screens/DiscoverySession.tsx`, `packages/ui/src/styles.css:1115` | M |
| Understanding Panel | Confirmed, interpreted, clarification, and decision sections form a long wall with repeated heading/count patterns. | Standardize section headers, counts, statement rows, provenance, and action reveal. Keep all current correction/dispute controls and keyboard order. | `packages/ui/src/screens/UnderstandingPanel.tsx`, `packages/ui/src/styles.css:1062` | M |

### Batch 3 — idea-to-specification workspace

| Screen | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| Idea Board | This is the strongest screen and already matches the intended direction. Its paper/grid, object palette, floating chrome, and spatial composition should remain. | Light-touch only: align chrome accents/elevation with global tokens, validate contrast in both themes, polish assistant/easy-edit consistency, and retain the current 4×4 minor grid subdivisions. | `packages/ui/src/screens/IdeaBoard.tsx`, `packages/ui/src/board-canvas/*.tsx`, `packages/ui/src/styles.css:1488` | S |
| Feature Workspace | Tabs expose rich content, but repeated panels and a narrow rail create equal visual weight across objective, facts, health, acceptance, design, quality, and release data. | Establish a stable feature header, primary content/decision rail hierarchy, consistent panel headings, and a distinct acceptance action well. | `packages/ui/src/screens/FeatureWorkspace.tsx`, `packages/ui/src/styles.css:1249` | L |
| Ticket Focus | Source structure has strong concepts—next action, content tabs, and status rail—but the live populated route currently fails from hook-order drift, so visual evidence is incomplete. | After the separate functional fix, emphasize Next Action, quiet the metadata rail, normalize tab content panels, and preserve every gate action. Styling work must not mask or alter the hook issue. | `packages/ui/src/screens/TicketFocus.tsx`, `packages/ui/src/ChatEdit.tsx`, `packages/ui/src/styles.css:902` | L |
| Wizard | Progress, question, answer choices, and bail-outs are functional but read as generic card and button stacks. | Give progress a labeled rhythm, strengthen question hierarchy, style choices as selectable option cards, and visually separate bail-outs from the forward path. | `packages/ui/src/screens/Wizard.tsx`, `packages/ui/src/styles.css:556` | M |
| Document Review | The markdown, version rail, diff links, and feedback area are clear but visually flat. | Create a comfortable reading surface, clarify version history selection, and make feedback a distinct decision composer without changing submit behavior. | `packages/ui/src/screens/DocReview.tsx`, `packages/ui/src/components.tsx:376`, `packages/ui/src/styles.css:669` | M |

### Batch 4 — execution and review operations

| Screen | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| Code Review | Counters, filters, actions, and findings are all independent blocks; finding severity relies mainly on badge color. | Create one review toolbar, align summary counters, give findings a severity edge/tint and clearer evidence/fix hierarchy, and standardize per-repo cards. | `packages/ui/src/screens/CodeReview.tsx`, `packages/ui/src/styles.css:1278` | M |
| PR Panel | Per-repo cards expose the right data but status badges, branch/SHA metadata, and destructive actions share similar weight. | Group state badges, format commit metadata consistently, and isolate primary retry/merge-adjacent actions from destructive actions. | `packages/ui/src/screens/PrPanel.tsx`, `packages/ui/src/styles.css:324` | S |
| Run Monitor | The list is a dense table with very long run IDs; detail view mixes counters, controls, warnings, and terminal output with weak boundaries. | Improve identifier truncation/copy visibility, row scanning, numeric alignment, run-status emphasis, and terminal header/action structure. | `packages/ui/src/screens/RunMonitor.tsx`, `packages/ui/src/styles.css:582`, `packages/ui/src/styles.css:519` | M |
| Failures & Escalations | Filter buttons and incident cards are serviceable but do not create a clear urgency ladder. | Use semantic filter counts, stronger failure/escalation surfaces, a predictable action column, and compact recovery metadata. | `packages/ui/src/screens/Escalations.tsx`, `packages/ui/src/styles.css:265` | M |
| Merge Center | Empty state dominates when idle; readiness cards use border color and checklist text but lack a strong ready/blocked summary. | Improve the idle explanation/action, give readiness cards a status header, and organize conflict/retry actions while preserving queue order. | `packages/ui/src/screens/MergeCenter.tsx`, `packages/ui/src/styles.css:1183` | M |

### Batch 5 — release, knowledge, analytics, and configuration

| Screen | Current state | Proposed change | Files | Effort |
| --- | --- | --- | --- | --- |
| Release Center | This is the densest composite screen. Scope, gates, deployments, exposure, notes, and retro each invent local form/table spacing. | Apply shared table/form/action-well patterns, strengthen release state and next action, standardize tab layouts, and group advanced inputs without changing lifecycle logic. | `packages/ui/src/screens/ReleaseCenter.tsx`, `packages/ui/src/styles.css:1183` | L |
| Knowledge Base | The dossier picker, many section tabs, markdown, gaps, versions, and editor are individually usable but visually fragmented. | Strengthen the dossier/section hierarchy, make tabs horizontally resilient, improve reading width/version history, and style edit mode as a deliberate state. | `packages/ui/src/screens/KnowledgeBase.tsx`, `packages/ui/src/styles.css:669`, `packages/ui/src/styles.css:1085` | L |
| Metrics | Stat cards are effective, but the three lower tables are flat and large empty regions make the page feel unfinished. | Group headline metrics by outcome/cost/throughput, improve value typography, and give lower data groups bounded surfaces and aligned numeric columns. No new charting dependency. | `packages/ui/src/screens/Metrics.tsx`, `packages/ui/src/styles.css:596` | M |
| Ledger | The picker and event cards are generic, so chronology and actor/stage changes are hard to scan. | Render events with a visual timeline rhythm, consistent timestamp/actor columns, quieter payload details, and a focused filter bar. | `packages/ui/src/screens/Ledger.tsx`, `packages/ui/src/styles.css:324`, `packages/ui/src/styles.css:620` | M |
| Settings | Full-width fields, long tab names, and sparse sections make configuration feel like raw schema editing. | Add a settings content width, section descriptions, two-column groups where safe, clearer dirty/save state, and scroll-resilient tabs. Preserve config paths and write-only secret behavior. | `packages/ui/src/screens/Settings.tsx`, `packages/ui/src/components.tsx:515`, `packages/ui/src/styles.css:495` | L |

## Global patterns

| Priority | Current state | Proposed pattern | Files | Effort |
| --- | --- | --- | --- | --- |
| P0 | Empty, loading, warning, error, and success states do not share anatomy or semantic surfaces. | Define icon/title/body/action slots through existing shared components and CSS. Use compact states inside panels and full states for page-level absence. | `packages/ui/src/components.tsx:17`, `packages/ui/src/styles.css:197`, state call sites in `packages/ui/src/screens/*.tsx` | M |
| P0 | Focus is globally visible, which is good, but focus, hover, active, selected, and drag-target states sometimes use the same accent-border vocabulary. | Keep the two-pixel focus-visible ring; assign background shift to hover, inset/pressed tone to active, accent fill/border to selection, and dashed accent to valid drop targets. | `packages/ui/src/styles.css:88`, `packages/ui/src/styles.css:869`, `packages/ui/src/board-canvas/nodes.tsx` | S |
| P1 | Motion uses one good timing token, but only a subset of interactive elements participates. | Extend the same 120–180ms motion family to card lift, modal/toast entry, disclosure, and selection changes. Transform motion is optional polish; opacity/color must carry the state. Keep all existing reduced-motion blocks effective. | `packages/ui/src/styles.css:76`, `packages/ui/src/styles.css:99`, `packages/ui/src/styles.css:2926`, `packages/ui/src/styles.css:3332` | S |
| P1 | At ≤720px rails stack, but the fixed 150px navigation leaves very little content width and dense toolbars wrap unpredictably. | In this pass, improve wrapping, table scroll containment, long-tab scrolling, and form stacking. A new mobile navigation pattern is deferred because it changes shell structure. | `packages/ui/src/styles.css:1457`, `packages/ui/src/App.tsx`, `packages/ui/src/screens/ReleaseCenter.tsx`, `packages/ui/src/screens/Settings.tsx` | M |
| P1 | Icon-only controls mix Lucide icons with text glyphs such as `?`, `✕`, and `z`. | Use the already-installed Lucide set for icon-only actions, retain visible text for named actions, and keep every current accessible name. | `packages/ui/src/App.tsx:260`, `packages/ui/src/screens/Home.tsx:141`, `packages/ui/src/screens/Board.tsx:430`, `packages/ui/src/board-canvas/tools/rail.tsx` | S |
| P2 | The shell and page content use a fixed 1100px cap even where wide tables and operational boards benefit from more space. | Add page-width variants: reading, standard, and wide. Assign them by screen without changing routes or data flow; the idea board remains full bleed. | `packages/ui/src/styles.css:175`, `packages/ui/src/App.tsx:271`, `packages/ui/src/screens/RunMonitor.tsx`, `packages/ui/src/screens/ReleaseCenter.tsx` | S |

## Voice-to-text follow-on plan

Voice-to-text is feature work, so it is **not part of the styling-only Phase 2**.
The free first version should follow the polish work as a separately approved
implementation. It requires no new dependency and no paid API.

### Product behavior

1. Place a microphone button inside or beside every multiline/long-form
   composer. It has four visible states: idle, requesting permission,
   listening, and finishing/error. Files initially affected:
   `packages/ui/src/screens/Capture.tsx`,
   `packages/ui/src/screens/CreateImport.tsx`,
   `packages/ui/src/screens/DiscoverySession.tsx`,
   `packages/ui/src/screens/DocReview.tsx`,
   `packages/ui/src/screens/FeatureWorkspace.tsx`,
   `packages/ui/src/screens/KnowledgeBase.tsx`,
   `packages/ui/src/screens/ReleaseCenter.tsx`,
   `packages/ui/src/screens/Wizard.tsx`,
   `packages/ui/src/ChatEdit.tsx`,
   `packages/ui/src/board-canvas/ItemEditorPage.tsx`,
   `packages/ui/src/board-canvas/nodes.tsx`,
   `packages/ui/src/board-canvas/AssistantPanel.tsx`, and
   `packages/ui/src/board-canvas/overlays.tsx`.
2. Insert final transcript text at the current caret/selection. Preserve existing
   text, undo history, controlled-input state, and line breaks. Dictation never
   submits, saves, or accepts a proposal automatically. Shared implementation:
   proposed `packages/ui/src/dictation/DictationControl.tsx` and
   `packages/ui/src/dictation/useDictation.ts`.
3. Show interim recognition separately from the committed field value. This
   avoids autosave churn on canvas nodes and makes uncertain text visibly
   provisional. Use a polite live region for start/stop/error; do not announce
   every interim token. Files:
   `packages/ui/src/board-canvas/nodes.tsx`, proposed dictation components, and
   `packages/ui/src/styles.css`.
4. Allow only one active dictation session application-wide. Starting another
   stops the first; route change, unmount, or explicit cancel aborts capture.
   Preserve keyboard access and expose `aria-pressed`, a clear accessible label,
   and Escape-to-stop while focus is in the composer. Files: proposed
   `packages/ui/src/dictation/DictationProvider.tsx`,
   `packages/ui/src/App.tsx`, and `packages/ui/src/hooks.ts`.
5. If recognition is unsupported, render a disabled microphone with a concise
   “Dictation unavailable in this browser” tooltip/accessible description.
   Manual typing remains unchanged. This is the progressive-enhancement choice
   approved for v1. Files: proposed dictation components and
   `packages/ui/src/styles.css`.

### Technical approach

- Detect `window.SpeechRecognition ?? window.webkitSpeechRecognition` behind a
  small adapter and add local TypeScript declarations rather than a package.
  Set `lang` from `navigator.language`, `interimResults = true`, and
  `continuous = true` where implemented; recover from browser-driven end events
  only while the user still intends to record. Files: proposed
  `packages/ui/src/dictation/speech-recognition.ts` and
  `packages/ui/src/dictation/web-speech.d.ts`.
- Normalize `not-allowed`, `service-not-allowed`, `audio-capture`, `network`,
  `no-speech`, `language-not-supported`, and aborted states into actionable UI
  copy. Do not log transcript text. Files: proposed dictation adapter/control
  and `packages/ui/src/components.tsx`.
- Do not claim that v1 is offline or private-by-architecture. The browser may
  use a vendor-hosted recognition service. Before the first recording, explain
  that audio handling is controlled by the browser and its provider. No audio
  is stored by Veto; recognized text follows the form’s existing save path.
  Files: proposed dictation control and `docs/PRD.md` when the feature is
  authorized.
- The standards surface is real but uneven. The Web Speech API defines
  recognition, while MDN currently marks `SpeechRecognition` capabilities as
  limited availability. On-device `available()`/`install()` support is newer
  and experimental, so it should be evaluated later rather than required for
  free v1. References:
  [Web Speech API specification](https://webaudio.github.io/web-speech-api/),
  [MDN interim results](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/interimResults),
  and [MDN on-device availability](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static).

### Voice implementation sequence and acceptance

1. Adapter, provider, dictation button, caret insertion, errors, and unit tests.
2. Roll into long-form app screens first: Capture, Create/Import, Discovery,
   Wizard, document feedback/editors, feature acceptance, release notes, and
   ChatEdit.
3. Roll into canvas text surfaces after verifying autosave and undo isolation.
4. Manually verify Chrome/Edge and Safari where the prefixed API is present;
   verify unsupported-state behavior in Firefox or any browser without the API.
5. Acceptance requires: no auto-submit, no lost pre-existing text, one active
   recorder, clear permission/error states, keyboard-operable controls,
   reduced-motion compliance, no transcript logging, and no regression when the
   API is absent. Test files would live under `packages/ui/test/`.

## Deferred / out of scope

| Item | Reason | Files |
| --- | --- | --- |
| Ticket Focus hook-order repair | It is a behavior fix and must be handled separately before the screen can receive reliable visual QA. | `packages/ui/src/screens/TicketFocus.tsx:143` |
| Voice-to-text implementation | It changes behavior and browser permissions. This document supplies the plan; implementation needs separate approval after the styling phase or an explicit scope change. | Proposed `packages/ui/src/dictation/*` plus the composer files listed above |
| Mobile navigation redesign | Replacing the fixed sidebar with a drawer/rail is structural product work. This pass only improves wrapping and narrow-screen containment. | `packages/ui/src/App.tsx`, `packages/ui/src/styles.css:1457` |
| New analytics charts | Useful for Metrics, but would add visualization behavior and likely a dependency. Phase 2 improves hierarchy with existing data and CSS. | `packages/ui/src/screens/Metrics.tsx` |
| Idea-board layout or tool redesign | The current board already matches the intended vision; large changes would spend effort where the product is strongest and risk established interactions. | `packages/ui/src/screens/IdeaBoard.tsx`, `packages/ui/src/board-canvas/*` |
| Command palette, notifications, and new global shell features | These are product features rather than polish. | `packages/ui/src/App.tsx` |
| Demo surface refresh | The demo has its own component and stylesheet and is not the production UI. | `packages/ui/src/demo/DemoApp.tsx`, `packages/ui/src/demo/demo.css` |

## Phase 2 execution and verification

1. Land theme tokens and shared primitives first. Review both themes before any
   screen-specific work.
2. Implement Batches 1–5 in order. Each five-screen batch remains a separate,
   reviewable logical change; shared fixes discovered later are kept small and
   explicitly attributed.
3. After each batch, inspect light and dark at desktop and narrow widths,
   keyboard through changed controls, and repeat reduced-motion checks.
4. At completion, run `pnpm typecheck`, `pnpm -F @veto/ui test`, and targeted
   Biome checks for every touched file, followed by the repository lint command
   required by `AGENTS.md`. Record any failure caused by unrelated dirty-tree
   work without modifying it.
5. Only after implementation and verification, add the required decision-log
   entry to `docs/TRACKER.md`. Phase 1 does not update the tracker because no
   polish decision has yet been approved or implemented.

Approval of this document authorizes the styling-only shared foundation and the
five screen batches. It does not authorize the deferred Ticket Focus behavior
fix or voice-to-text implementation.
