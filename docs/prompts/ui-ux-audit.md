# Prompt — Veto app-wide UI/UX audit (research only)

You are a senior product designer + frontend engineer performing a
**research-only UI/UX audit** of the Veto web app — every screen EXCEPT
the idea board. Your deliverable is a single markdown report with
issues, recommendations, and concrete solutions. **You will not change
any product code.**

## 0. Clarifying questions — ask first

Before auditing, you may ask up to **five questions** for additional
context and clarification. Ask them **one at a time** — pose one
question, wait for the answer, then decide whether the next question is
still needed. Do not batch questions. Do not ask anything you can
answer yourself from the codebase or `docs/`. When your questions are
answered or the five-question budget is spent, proceed to the audit
without pausing again.

Good candidates (use only if genuinely unresolved after reading the
code): target viewport/device range, dark vs light theme priority,
density preference, polish-only vs. willingness to restructure layouts,
primary audience (developers only vs. mixed).

## 1. Context

Veto is a governance layer for agent-authored code: capture ideas, turn
them into governed work, and make the next human or agent action
unmistakable. Home is the daily operating surface (pipeline board +
needs-attention inbox); the hierarchy runs
project → board → initiative → feature → ticket.

UI stack: React 18 + react-router-dom v6 + Vite. Hand-rolled CSS in a
single `packages/ui/src/styles.css` (~2.4k lines, theme + `--canvas-*`
tokens, dark/light). lucide-react icons, Inter + JetBrains Mono.
`@xyflow/react` is used only on the out-of-scope board canvas. The app
is served by the conductor daemon on `:4711`; a demo mode exists
(`src/demo/`).

**Binding references — read these first. The product's specified
behavior is authoritative; you audit execution, not intent.**

- `docs/UI-INVENTORY.md` — canonical workflow/page/shared-surface
  index (WF-xx workflows, S-xx screens). Your coverage must map to it.
- `docs/PRD.md` §15 — screen-level product intent.
- `docs/TRACKER.md` decision log — esp. **D26** (hierarchy/vocabulary),
  **D28** (inventory reconciliation), **D57/D59** (board canvas +
  polish — settled, out of scope).
- `AGENTS.md` — repo conventions; spec gaps get resolved + backported
  into `docs/`, never silently worked around.

## 2. Scope

**In scope** — every route and shared surface below:

| Route | File(s) |
| --- | --- |
| `/` (Home = pipeline board + inbox) | `screens/Home.tsx`, `screens/Board.tsx`, `screens/Inbox.tsx`, `screens/UnderstandingPanel.tsx` |
| `/boards` (list only) | `screens/Boards.tsx` |
| `/capture` + ⌘⇧C Quick Capture modal | `screens/Capture.tsx`, `App.tsx` |
| `/tray` | `screens/Tray.tsx` |
| `/new` | `screens/CreateImport.tsx` |
| `/discovery/:ws/:session` | `screens/DiscoverySession.tsx` |
| `/features/:ws/:id` | `screens/FeatureWorkspace.tsx` |
| `/tickets/:ws/:id` | `screens/TicketFocus.tsx` |
| `/tickets/:ws/:id/wizard` | `screens/Wizard.tsx`, `wizard.ts` |
| `/tickets/:ws/:id/docs/:name` | `screens/DocReview.tsx` |
| `/tickets/:ws/:id/review` | `screens/CodeReview.tsx` |
| `/tickets/:ws/:id/pr` | `screens/PrPanel.tsx` |
| `/tickets/:ws/:id/ledger`, `/ledger` | `screens/Ledger.tsx` |
| `/runs`, `/runs/:id` | `screens/RunMonitor.tsx` |
| `/queue` | `screens/Escalations.tsx` |
| `/merge-center` | `screens/MergeCenter.tsx` |
| `/releases`, `/releases/:ws/:rel` | `screens/ReleaseCenter.tsx` |
| `/metrics` | `screens/Metrics.tsx` |
| `/workspaces` | `screens/Workspaces.tsx` |
| `/kb` | `screens/KnowledgeBase.tsx` |
| `/settings` | `screens/Settings.tsx` |
| Global chrome | `App.tsx` (nav, badge, toasts, modal, Escape), `components.tsx`, `ChatEdit.tsx`, `Evidence.tsx`, `Alignment.tsx`, `RsQuality.tsx`, `Traceability.tsx` |

**Out of scope — do not audit, do not write findings against:**

- `/boards/:ws/:board` → `screens/IdeaBoard.tsx` and all of
  `src/board-canvas/` — a dedicated polish pass already landed (D59).
  You may note where shared chrome (nav, toasts, tokens) affects it,
  but no screen-level findings.
- `src/demo/DemoApp.tsx`, `dist/`, test files.
- Backend/API design — a recommendation may note "requires API work,"
  but the audit itself is UI/UX only.

## 3. Method

1. Build the screen list from `docs/UI-INVENTORY.md` + the `<Routes>`
   in `App.tsx`. Confirm nothing in scope is missed.
2. Per screen: read the component, its CSS section(s), and the WF-xx
   workflow it serves. Inventory every state (empty / loading / error
   / populated / truncated / oversize content) and every interactive
   element across every state (hover / active / focus-visible /
   disabled / busy / selected).
3. Walk the keyboard path and the failure paths, not just the happy
   path.
4. Reason about geometry — "pixel perfect" means computed sizes,
   alignment, and overflow traced to numbers, not vibes.
5. If you can run the app, do: `pnpm install && pnpm -r build`, then
   `node packages/cli/dist/bin.js daemon` (UI+API on :4711; bootstrap
   `http://127.0.0.1:4711/?token=$(cat ~/.config/veto/ui-token)`).
   Capture/eyeball each screen at desktop + narrow widths, dark +
   light. If you cannot run it, say so and mark visual claims
   "code-review only."

## 4. Audit dimensions — apply to every screen

Tag every finding with one: `ux-flow` | `visual` | `state-coverage` |
`a11y` | `copy` | `consistency` | `spec-drift` | `bug`.
Rate severity: `blocker` | `high` | `medium` | `low` | `nit`.

- **Visual system** — one spacing scale vs one-off literals, radius
  and elevation ladders, type scale, token hygiene (stray literals,
  dead rules), grid alignment, optical centering.
- **Information architecture** — hierarchy, density, scanability; does
  the "next action unmistakable" test pass on each screen?
- **Flows** — task paths per UI-INVENTORY WF-xx, dead ends, orphan
  states, confirmation/undo where destructive.
- **States & feedback** — empty states that teach, honest
  loading/error/offline, save/busy indicators, toast + badge honesty,
  disabled affordances that explain themselves.
- **Micro-interactions** — one duration/easing scale,
  `prefers-reduced-motion` everywhere, correct cursors, hit areas,
  icon optical sizing.
- **Copy** — sentence case, consistent verbs, tooltips on icon-only
  controls, no jargon leakage, no dead copy.
- **Accessibility** — ARIA roles/labels, contrast, tab order, focus
  visible + focus restoration, touch targets.
- **Cross-cutting** — nav model, Quick Capture modal, toast system,
  command/search surface, responsive/narrow-width behavior.
- **Pixel-perfect detail** — truncation + ellipsis, tabular numerals
  on ticking counters, alignment of chrome on the edge grid, last-10%
  fit and finish.

## 5. Deliverable — `docs/UI-UX-AUDIT.md`

The only file you write. Structure:

1. **Executive summary** — themes, finding counts by severity and
   dimension, the five highest-impact recommendations.
2. **Global / design-system findings** — tokens, scales, shared
   components, chrome.
3. **Per-screen sections** (one per route above): findings table with
   `# | tag | severity | issue | recommendation`, where each
   recommendation is concrete — name the file, selector/component, and
   the specific change (values, states to add, copy text). Flag
   quick wins.
4. **Cross-screen recommendations** — nav, toasts, modal patterns,
   shared empty-state/loading patterns, focus system.
5. **Deferred** — anything needing an API change, state-model change,
   new dependency, or component restructure; listed explicitly, not
   silently dropped.
6. **Coverage checklist** — every in-scope route with ✓ and how it was
   verified (code review / live capture + which viewports/themes).

Recommendation rules: concrete and implementable; cite the
best-practice principle only where it earns it; never propose
violating a binding spec — flag the conflict and propose a resolution
instead; no new dependencies.

## 6. Hard constraints

- **Research only** — zero code changes. The single file you create is
  `docs/UI-UX-AUDIT.md`. Do not touch `src/`, `styles.css`, or tests.
- **Idea board excluded** — see §2.
- **Specs are binding** — audit execution against intent; spec gaps
  get a proposed resolution in the report, not a workaround.
- **Full coverage** — the checklist must cover every route in §2;
  partial coverage is a failed audit.
- **Honest verification** — mark every visual claim "code-review" or
  "verified live (viewport/theme)"; never claim pixel-perfect you
  didn't measure.
- **Don't commit anything.**
- Repo conventions still apply where relevant: ESM/strict TS awareness
  when reading code, secrets never logged, real `git` only.
