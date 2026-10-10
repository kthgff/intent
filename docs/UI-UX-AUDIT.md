# UI/UX Audit — Veto web app (all screens except idea board)

Research-only audit of every non-idea-board surface of `packages/ui`.
Audited against `docs/UI-INVENTORY.md`, `docs/PRD.md` §15, and `AGENTS.md`
conventions. Findings are tagged `ux-flow` | `visual` | `state-coverage` |
`a11y` | `copy` | `consistency` | `spec-drift` | `bug`, rated
`blocker` | `high` | `medium` | `low` | `nit`, and flagged **⚡ quick win**
(CSS/markup/local interaction change) vs. **(structural)** (component,
IA, API, or workflow change). Density is preserved per audit direction —
recommendations tighten, not loosen, the existing layouts.

Evidence levels: **code-review** (traced through source/CSS) or
**verified live (viewport/theme)** (captured from the running daemon at
`1440×900` or `880×900`, `dark` or `light`).

> No product code, styles, tests, or other docs were modified for this
> audit. The idea-board canvas (`/boards/:ws/:board`,
> `screens/IdeaBoard.tsx`, `src/board-canvas/`) is excluded throughout.

---

## 1. Executive summary

The app is visually coherent — a restrained dark/light token palette,
consistent card/chrome language, honest data states — but it is
**unfinished at the design-system level**. A large share of screen time
is spent in machine-facing artifacts (raw status strings, gate ids, run
ids, JSON dumps), shared primitives are half-defined (dozens of used
classes have no CSS rule), and the spec-mandated chrome (command/search,
connection state, notifications popover) is absent. The strongest
screens (ReleaseCenter, MergeCenter, Settings) prove the visual language
works when a surface gets attention; the weakest (Board controls,
UnderstandingPanel, transcript surfaces) expose unstyled defaults.

### Themes

- **Machine strings leak into UI copy** — `changes-requested`,
  `p:high`, `prd-review`, `vocab-growth`, `interview-…/001-interview`,
  `wont-do`, `ci-watch`. The app speaks API, not product.
- **Classes used but never styled** — `.list`, `.panel`, `.link`,
  `.link small`, `.dim`, `.spread`, `.findings`, `.finding`, `.sev-*`,
  `.citation`, `.accept-box`, `.alignment-panel`, `.align-finding`,
  `.align-refs`, `.discovery-main`, `.feature-workspace`, `.page`,
  `.compact`, `.chat-line`, `.chat-*`, `.msg-user`, `.spec-dim`,
  `data-blocked` — ~25 hooks default to browser styles.
- **Destructive/consequential actions lack confirmation** — tray
  `delete`, `wont-do` (ticket + queue), run `Kill`, release scope
  `remove`, PR `Revert`, wizard `force-ready`/`wont-do` — none confirm.
- **A11y pass incomplete** — no app-wide `:focus-visible`, dialogs lack
  focus management, icon-only buttons unlabeled, tab lists are partial
  ARIA, `Field` labels are `span`s.
- **Live-verified failures** — failed runs render Pause/Kill buttons,
  transcripts show a perpetual "waiting for chunks" placeholder on dead
  runs, and all status badges render identical (`.status-*` never
  styled).

### Findings by severity

| Severity | Count |
| --- | --- |
| blocker | 0 |
| high | 14 |
| medium | 70 |
| low | 83 |
| nit | 8 |

### Findings by dimension

| Tag | Count |
| --- | --- |
| ux-flow | 56 |
| a11y | 31 |
| visual | 26 |
| state-coverage | 19 |
| copy | 14 |
| bug | 13 |
| consistency | 9 |
| spec-drift | 7 |

### Top 5 highest-impact recommendations

1. **Define the missing shared classes** (`styles.css`: `.list`,
   `.panel`, `.link`, `.dim`, `.findings/.finding`, `.sev-*`,
   `.citation`, `.chat-*`, `.spec-dim`, etc.). ~60 lines of CSS fix the
   default-bullet lists, unstyled finding rows, and invisible links
   across ~15 components. *⚡ biggest quality-per-line win.*
2. **Complete the badge system** — map `StatusBadge`'s `.status-*` hooks
   to token tones (`.status-failed → bad`, `.status-pending → dim`,
   etc.) and humanize the rendered labels. Every status currently looks
   identical (verified live).
3. **Add app-wide focus-visible + motion rules** — a global
   `:focus-visible` ring (accent, 2px) and a `transition` scale
   (120–160ms) with `prefers-reduced-motion` guard. All existing
   transition/focus rules live in the out-of-scope canvas section.
4. **Confirm destructive actions** — one shared `ConfirmDialog` (the
   Board already has the `pending-drop` pattern to reuse) wired to tray
   delete, wont-do, kill, revert, scope remove.
5. **Humanize visible strings** — a `humanizeStatus()`,
   `humanizeKind()`, `humanizeGate()` map at one import site
   (`components.tsx`) removes hyphenated machine strings from badges,
   headers, inbox, findings, and counters everywhere.

---

## 2. Global / design-system findings

### Tokens, scales, chrome

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| G1 | bug | high | Bundled fonts never used. `main.tsx` imports Inter 400/500/600 + JetBrains Mono 400/600; `body` uses `-apple-system, "Segoe UI", Roboto…` and `.mono`/`.terminal`/`.chat-text` use `ui-monospace, "SF Mono", Menlo, monospace`. The stray bare `monospace` also sits mid-stack as a third fallback, so generic-mono can preempt the explicit stacks. Verified live — nav/body render system font. | ⚡ In `styles.css`: `body { font-family: Inter, -apple-system, "Segoe UI", Roboto, sans-serif; }`; `.mono, .terminal, .chat-text { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; }`; drop the stray `monospace`. |
| G2 | bug | high | `StatusBadge` renders `className="badge status-{status}"` — zero `.status-*` rules exist → every status (draft/open/blocked/failed/done) is an identical neutral pill. Verified live (failed run badge = gray). | ⚡ Add tone mappings: `.badge.status-failed,.badge.status-blocked,.badge.status-merge_conflict { color:var(--red); border-color:var(--red) }` etc. for ~10 statuses → map to `bad`/`warn`/`good`/`accent`/`purple`. Same fix covers `.sev-*` variants if kept (see G15). |
| G3 | visual | medium | No spacing/radius/elevation scale — literals everywhere: `padding: 5px 12px` / `6px 9px` / `10px 14px` / `12px 14px` / `16px` / `20px 28px` / `32px`; radius `6/8/10`; border 1px. Only the four `spec-*` tones are tokenized. | (structural) Introduce `--space-{1..6}` (4/8/12/16/20/24), `--radius-{sm,md}` (6/8), `--shadow-1`, `--font-{sans,mono}`; migrate the top ~20 literals. Mechanical refactor, no visual change. |
| G4 | a11y | high | No `:focus-visible` anywhere outside the canvas section (line 1070+). Tab navigation relies on UA defaults; dark accent buttons show an invisible-on-dark focus outline in some browsers. | ⚡ Global: `button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` + `button:focus:not(:focus-visible), a:focus:not(:focus-visible) { outline: none; }`. |
| G5 | visual | medium | Zero `transition`/`animation` outside canvas — hover states are border-color snaps. First transition is line 1062. | ⚡ Add `transition: border-color 120ms, background-color 120ms, color 120ms` to `button:hover`, `.card`, `.tray-row`, `.tabs button`, `a`. Add a single global `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }` (currently canvas-only). |
| G6 | bug | medium | `.toasts { z-index: 10 }` sits under `.modal-back { z-index: 20 }` — toast fired during an open modal (e.g., "Captured → tray" after a ⌘⇧C save) renders behind the backdrop, invisible. | ⚡ Raise `.toasts` to `z-index: 30` (above modal but below nothing else — there is no higher layer). |
| G7 | a11y | medium | Modal pattern incomplete: `<dialog open>` (not `showModal()`), `role="presentation"` backdrop, no initial focus, no focus trap, no focus restore. Applies to Quick Capture (App.tsx), Board drop-confirm, DiscoverySession briefing, Ledger PickTicket, KB confirm. | (structural) One `Modal` component: `showModal()` or `aria-modal="true"`, `autofocus` the first control (or focus the dialog container with `tabindex="-1"`), trap Tab, restore focus to opener on close, Escape closes (already wired via `useEscapeKey`). |
| G8 | consistency | medium | Three feedback channels coexist: global `.toasts` (App), per-screen `.warn-banner` (Board, Tray, Boards, DiscoverySession), inline success banners (`save-banner`, `done` card in DocReview, `syncMsg` in KB, `saved` in Settings). Toasts transient; warn banners persist until dismiss — same role, different lifecycle. | (structural) Route all three through `pushToast` (expose via context) or split clearly: `.banner` component with `variant={info,warn,error,success}` for persistent inline messages, toasts for confirmations. At minimum unify styling/position. |
| G9 | a11y | medium | `Field` renders `<span className="field-label">` — label is not programmatically associated; clicking it does nothing, SR users get unlabeled inputs. ~40+ usages. | ⚡ `Field` should render `<label htmlFor={id}>` and forward a generated `id` to `children` (accept `id` prop or clone). Keeps markup identical otherwise. |
| G10 | visual | medium | Ticking counters lack `font-variant-numeric: tabular-nums` — `.counter .v` (Metrics/RunMonitor), elapsed ticker, `fmtTokens`, inbox count badge — width jitters per digit change. | ⚡ Add `font-variant-numeric: tabular-nums` to `.counter .v`, `.mono`, `.terminal`, `.elapsed` (or wherever the ticker renders), and `.badge.count`. |
| G11 | state-coverage | low | `Loading` renders bare dim text — indistinguishable from a failed/empty page on slow loads; no `aria-busy`/`role=status`. | ⚡ Add a 12–14px CSS spinner (border-spin) inside `.state`, plus `role="status"`. Optional `skeleton` variant for list/table placeholders. |
| G12 | copy | medium | Raw machine strings: `StatusBadge`/`StatusStepper` render `changes-requested`, `prd-draft`, `ci-watch`, `wont-do`, `merge_conflict`; inbox `p:high` + gate ids; run ids `interview-…/001-interview`; kind keys `vocab-growth`. | ⚡ Central maps in `components.tsx`: `STATUS_LABEL`, `KIND_LABEL`, `GATE_LABEL`, `PRIORITY_LABEL` → `StatusBadge`, `KindBadge`, stepper, inbox card all call `label(s)`. Fallback `humanize(s)` = `s.replaceAll('-',' ')`. |
| G13 | a11y | medium | Tabs are partial ARIA: `role="tablist"`/`role="tab"`/`aria-selected` on Home/TicketFocus/Settings/ReleaseCenter/DiscoverySession, but no `aria-controls`/`id` pairing, no `role="tabpanel"` on panels, no arrow-key navigation; KB + CreateImport tabs have no roles at all. | ⚡ Extract `Tabs({tabs, active, onChange})` in `components.tsx` that emits `tab`/`tabpanel` pairs, `aria-controls`, roving `tabindex`, and Left/Right/Home/End handlers — reuse everywhere. |
| G14 | bug | low | `DiffView` colors diff headers as added/removed code: `+++ b/file` and `--- a/file` start with `+`/`-` and land in `.diff-line-add`/`.diff-line-del`. | ⚡ Skip color rules for lines matching `^(+++|---)` (or skip first two header lines); add `.diff-file { color: var(--accent); background: var(--bg-raised); }` for `diff --git`/`---`/`+++` lines. |
| G15 | consistency | medium | ~25 class hooks used but never styled (see themes). Worst visible effects: `.list` bullets render default disc+indent in UnderstandingPanel/FeatureWorkspace/DiscoverySession/Sessions; `.link` buttons look like buttons (not links); `.panel` lacks card chrome; `.dim` on `.board-card`/`.spec` uses no dimming; `.sev-*` badges identical; `.chat-line .chat-user` no distinction. | ⚡ Add the missing rules — `.list{list-style:none;margin:0;padding:0}`, `.list li{padding:6px 0}`, `.link{background:none;border:none;color:var(--accent);cursor:pointer;padding:0}`, `.dim{color:var(--text-dim)}`, `.panel{background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:12px 14px}`, `.sev-blocker/major→red, minor→yellow, nit/question→dim`, `.chat-line .msg-user{color:var(--accent)}`, `.spec-dim{color:var(--text-dim);border-color:var(--border)}`. |
| G16 | consistency | low | `input,select,textarea{width:100%}` forces ~20 inline `style={{width:'auto'}}` overrides; more inline literals: `marginTop`, `width:220`, `maxWidth:640`, `maxHeight:240`, `paddingRight`. | ⚡ Add `.auto{width:auto}` utility (or move `width:100%` onto `.field` controls only) + class for the recurring `marginTop:12` stack — kill the inline sprawl. |
| G17 | a11y | nit | No skip-to-content link; `nav`/`main` landmarks exist. | ⚡ `<a href="#main" className="skip">Skip to content</a>`; `.skip{position:absolute;left:-9999px}` + `.skip:focus{left:12px;top:12px;z-index:40}`. |
| G18 | spec-drift | high | Spec'd global chrome absent (UI-INVENTORY §3, PRD §15 S-00): no global search / ⌘K command palette (WF-23), no notification popover w/ mark-read, no connection/live-state indicator (SSE reconnects silently — user can't tell stale from live), no actor identity, no keyboard-shortcut help. | (structural, partially deferred) Implement the chrome per spec: connection dot in nav (live/SSE reconnecting/offline), `?` shortcut help, ⌘K palette (commands + global search), notification popover bound to `api.events`. Biggest gap for an ops tool: connection state. |
| G19 | bug | medium | Theme is bootstrapped but never user-controllable: `index.html` reads `localStorage["veto.theme"]`/`["intent.theme"]` + `prefers-color-scheme` once at boot; nothing writes it (Settings has no theme control though `ui.theme` exists in SETTINGS spec); no `matchMedia` change listener → OS switch doesn't propagate. | ⚡ Add a Theme select in Settings → "Merge & UI" that writes `localStorage.setItem("veto.theme", v)` + `document.documentElement.dataset.theme = v` (options: `system`/`dark`/`light`). Add `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', …)` honoring the saved pref. |
| G20 | visual | medium | Zero `@media` breakpoints in non-canvas CSS. `.split` (grow + 260px `.rail`), `.tray-layout` (`1fr 320px`), `.board` (scrollable columns) hold at 880px verified live, but below ~720px the rail/inspector squeeze content to slivers; `.main` padding never shrinks. | ⚡ Add `@media (max-width: 720px)` rules: `.split, .tray-layout, .discovery-layout { flex-direction/grid-template-columns: column }`, `.rail { width: 100% }`, `.inspector { position: static }` (or `100%`), `.main { padding: 12px }`, `.board { flex-direction: column }` (columns stack instead of horizontal scroll — keep density, not slivers). |
| G21 | state-coverage | medium | `ErrorBox` dumps `e.message` raw — `ApiError` carries `code` (`clone_failed`, `conflict`, `not_found`) but it's never shown; no retry, no dismiss, no "copy details". Each screen re-implements the same `<ErrorBox e>` with a `load()` retry button inconsistently. | ⚡ Upgrade `ErrorBox`: friendly map `{ not_found: "Couldn't load this.", conflict: "…" }` + `code` chip + optional `onRetry`/`onDismiss` props; wire retry at every call site that currently pairs `<ErrorBox><button onClick={load}>`. |
| G22 | a11y | medium | Icon-only buttons unlabeled: capture-tray `✕`, ChatEdit `✕`, tray inspector `×`, Board snooze `z` (title-only). | ⚡ Add `aria-label` on each (`"close"`, `"close session"`, `"close inspector"`, `"snooze attention items"`); `z` → lucide `Moon`/`BellOff` icon + label. |
| G23 | ux-flow | nit | `main` keyed on `location.key` forces full remount per navigation — kills scroll position *and* any pending UI state on same-route param changes; acceptable but worth a comment or `location.pathname` key. | ⚡ `key={location.pathname}` preserves state across query changes; remount only on real route swaps. |
| G24 | visual | nit | `.terminal` hardcodes `background:#0a0d12` + `color:#9fd3a8` — intentional "terminal stays dark" aesthetic in light theme, but it's the only untheme'd surface; verify deliberate. | ⚡ If deliberate: add a comment + move literals to `--terminal-bg`/`--terminal-text` tokens so they're documented. If not: theme them. |
| G25 | a11y | low | Hit areas: `.small` buttons ~28px tall, `.board-snooze` ~22px, tab buttons ~33px — below the 32–40px comfortable range on narrow/touch. | ⚡ Bump `.small` to `min-height: 30px` and `button` to `min-height: 32px`; `line-height` unchanged. Keeps density, adds ~2–4px. |

---

## 3. Per-screen findings

### 3.1 `/` — Home (`screens/Home.tsx`, `Board.tsx`, `Inbox.tsx`, `UnderstandingPanel.tsx`)

Live-verified: dark/light @1440, narrow @880 — nav+tabs+board columns render correctly; empty columns show `—`; inbox badge `5` on Home nav item.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| H1 | ux-flow | medium | Board tab shows no attention count — the only inbox signal lives in the left-nav `Home 5` badge. Once on the Board tab, nothing says how many items wait in Inbox. | ⚡ Render `.count` on the **Inbox** tab button itself (Home.tsx): `{count ? <span className="count">{count}</span> : null}` — count already fetched. |
| H2 | a11y | medium | Tabs partial ARIA (see G13): no `aria-controls`/`tabpanel` pairing, no arrow keys. | ⚡ Shared `Tabs` component (G13). |
| H3 | visual | low | `.tabs` override via inline `border:'none'`; `h1` gets inline `marginRight:12`. | ⚡ `.tabs-inline{border:none;margin-bottom:0}` class; `h1` keeps `.page-title` margin. |
| H4 | state-coverage | low | Capture-tray success "Captured to tray." is an inline dimmed span beside the button — easy to miss; `ErrorBox` in the same flex row wraps awkwardly at narrow widths. | ⚡ Route success through `pushToast` (needs toast context — structural), or give the inline note a `.save-banner`-style treatment so it reads as feedback not caption. |
| H5 | a11y | medium | `✕` close button is icon-only with no label. | ⚡ `aria-label="close capture"`. |
| H6 | state-coverage | low | If `api.workspaces()` fails, the capture tray's project `<select>` renders empty — Save disabled with no explanation (fetch has `.catch(()=>{})`). | ⚡ Show inline "Couldn't load projects — retry" in the select row when `workspaces.length===0` after load. |
| B1 | a11y | high | Drag-and-drop has no keyboard/touch alternative — cards are `draggable` articles; status moves are unreachable without a pointer. | (structural) Per-card `⋯` menu (or a "move" affordance on focus) exposing `drop_targets` as menu items; or a "move to" select in the card inspector. |
| B2 | copy | medium | Label vocabulary drifts: filter says "Workspace", capture form says "project", inventory/PRD use Project. D26 decided the hierarchy names. | ⚡ Align labels to spec vocabulary — "Project" in filter labels on Board/Inbox/Tray/Boards/Escalations/ReleaseCenter. |
| B3 | ux-flow | medium | `z` snooze button — cryptic glyph, ~22px hit area, tooltip-only discovery. | ⚡ lucide `Moon`/`BellOff` icon + `aria-label="snooze attention items"`; keep `.small` footprint. |
| B4 | ux-flow | low | Drop-confirm modal shows generic `Confirm` — doesn't restate the action; `<dialog>` lacks modal semantics (G7). | ⚡ Label the primary button with the action: `"Move to {target}"` or `"Confirm {action}"`; shared Modal component fixes semantics. |
| B5 | visual | low | `· recent` marker on done-column overflow is cryptic; ops-strip chips show raw `subject · gate`. | ⚡ `title="recently shipped"` tooltip + humanized gate names (G12). |
| B6 | state-coverage | low | SSE reload calls full `load()` → `setLoading(true)` only fires on mount/workspace change; manual Refresh also resets `loading` → whole board flickers to "Loading…". | ⚡ Pass a `silent` flag to `load()` for SSE/refresh; show a small spinner on the Refresh button instead of full-page Loading. |

### 3.2 Inbox (`screens/Inbox.tsx` — rendered inside `/`)

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| I1 | ux-flow | high | Items show only `subject · gate` — no ticket title, no question preview. Users can't triage "what needs me" without clicking through. | (structural/API) Surface a `title`/summary in the inbox payload; until then ⚡ humanize the `gate` label (G12) and show `blocked_reason` where present. |
| I2 | visual | medium | Gate id raw in link text (`prd-review`); priority `p:high` token. | ⚡ `GATE_LABEL`/`PRIORITY_LABEL` maps (G12). |
| I3 | consistency | medium | `card-meta` shows raw ISO `surfaced {iso}` while title row shows `fmtAge` — two time formats on one card. | ⚡ `fmtAge` in the meta line too; `title={iso}` for exact. |
| I4 | ux-flow | medium | `claim`/`release`/`snooze` all render `.small` equal weight — primary action unclear. | ⚡ `claim` → `.small primary`; `release` only shown when claimed (already conditional); `snooze` → icon button with label. |
| I5 | bug | low | `data-blocked` attribute set on cards but never styled — dead hook. | ⚡ Either `[data-blocked] { border-left: 3px solid var(--red) }` (parity with `.board-card.flag-blocked`) or drop the attribute. |
| I6 | ux-flow | low | Snooze is fixed 24h — title-only discoverability; unsnooze exists. | ⚡ Label text "snooze 24h" or a small duration menu (structural). |
| I7 | a11y | low | Group lists are `<div>`s — no list semantics under `h2.group-title`. | ⚡ Wrap groups in `<ul>`/`<li>` or `role="list"`/`role="listitem"`. |

### 3.3 UnderstandingPanel (`screens/UnderstandingPanel.tsx`)

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| U1 | a11y | high | `dispute` uses `window.prompt` — native dialog, unthemed, breaks focus management, unfriendly in dark theme. | ⚡ Replace with the same inline input pattern used for the decision ruling (prompt row with `autoFocus`, submit on Enter, `aria-label="dispute reason"`). |
| U2 | visual | medium | `.list` unstyled (G15) — every bucket shows default bullets + indent; the rows were designed for a custom list. | ⚡ `.list` rule (G15) fixes this, transcript, sessions, briefing at once. |
| U3 | visual | medium | Every statement row renders a `<details class=provenance>` + 4 text buttons — dense chrome per row; bucket headers muted. | ⚡ Show action buttons on `hover`/`focus-within` only (`.statement-row .actions{opacity:0} .statement-row:hover .actions{opacity:1}`); keeps density, declutters. |
| U4 | copy | low | Action labels lowercase (`confirm`, `correct`, `dispute`, `reject`, `dismiss`) vs. title-case elsewhere. | ⚡ Sentence-case labels. |
| U5 | a11y | low | Slot values live only in `title=` tooltips — keyboard/touch users can't see them. | ⚡ `aria-describedby` or make chips expandable (`<details>`-style) so values are reachable. |
| U6 | visual | low | Readiness line `draft ✓ · approval ✗` is cryptic. | ⚡ Spell out: `draft ready · approval blocked`, with ✓/✗ colored `var(--good)`/`var(--red)`. |

### 3.4 `/capture` + ⌘⇧C modal (`screens/Capture.tsx`, `App.tsx`)

Live-verified: dark/light @1440, narrow @880 — form renders; modal code-reviewed only (not captured).

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| C1 | ux-flow | medium | ⌘⇧C opens the modal but focus stays in the page — typing goes to the wrong place until user clicks. Verified by code: `<dialog open>` doesn't autofocus; no `autoFocus` on textarea. | ⚡ `autoFocus` on the textarea when modal mounts; shared Modal trap/restore (G7). |
| C2 | state-coverage | medium | If `captureData` fetch fails, modal form has no workspaces/boards — Save disabled silently. | ⚡ Inline error in the modal: "Couldn't load projects — retry" (same pattern as H6). |
| C3 | visual | low | `.capture-form.compact` modifier never styled — modal form keeps page-form spacing, cramped inside the dialog. | ⚡ `.capture-form.compact{gap:8px}` + tighter `.field` margin; or drop the modifier. |
| C4 | ux-flow | low | In the modal's `save-banner`, "open destination →" navigates behind the still-open modal — user lands on the destination but the overlay persists. | ⚡ Close the modal on `navigate()` — `onNavigate` in the banner should also call `setCaptureOpen(false)`. |
| C5 | a11y | low | Kind chips fieldset uses `aria-label="type"` — good; but there is no visible "type" label, inconsistent with project/to labels. | ⚡ Add `<span className="field-label">type</span>` before chips (or a legend-styled span). |
| C6 | ux-flow | low | Board destination only fetched for the *first* workspace in the modal (`names[0]`); switching project refetches — fine — but the initial select defaults to `workspaces[0]`, not context. | ⚡ Default the modal's project select to the currently-viewed workspace if the app tracks one (structural: needs global scope state); otherwise document the default. |

### 3.5 `/tray` (`screens/Tray.tsx`)

Live-verified: dark/light @1440, narrow @880 — search + kind select + empty state render; inspector closed.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| T1 | ux-flow | high | `delete` is `small danger` with **no confirmation** — irreversible. | ⚡ Confirm via the Board `pending-drop` modal pattern (or shared `ConfirmDialog`); label `"Delete item"` and cite the item title. |
| T2 | a11y | medium | Inspector `×` close has no `aria-label`; inspector doesn't move focus on open; Escape doesn't close it. | ⚡ `aria-label="close inspector"`; focus the inspector heading on open; `useEscapeKey(()=>setSelected(null))`. |
| T3 | ux-flow | medium | Type/importance selects write immediately on change — silent save; no "saved" signal. | ⚡ Transient "saved" microcopy next to the select (or toast); an `aria-live` polite region announcing "saved". |
| T4 | state-coverage | medium | If filters hide the selected row, the inspector silently disappears — selection lost without notice. | ⚡ Keep `selected` independent of the filtered list (`items.find(i=>i.id===selected)` on the full list), or toast "item hidden by filter". |
| T5 | visual | low | Search input is full-width — at 1440px it wraps the kind select + `+ Capture` onto a second row (verified live). | ⚡ `style={{width:220}}` is already there — move it to a class and set `max-width: 260px`; keep the controls on one row. |
| T6 | ux-flow | low | `moveTarget` select persists after Move; move success is silent (no toast — only `patch()` refresh). | ⚡ Reset `moveTarget` post-move; toast `"moved to {board}"`. |
| T7 | copy | low | `park`/`delete` lowercase vs. `Move`/`Edit` title case. | ⚡ Sentence-case all tray actions. |

### 3.6 `/boards` (`screens/Boards.tsx`)

Live-verified: dark @1440 — list + create form render; no sessions card (empty).

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| BO1 | spec-drift | medium | S-15 spec asks for per-board counts (open/consumed/shipped/parked/stale), tray count, last synthesis, search/sort, templates, archive — impl shows name/type/status/outputs only. | (structural/API) Extend `api.boards()` payload with counts + `last_synthesis` (deferred); ⚡ render existing fields with a `KindBadge`/`StatusBadge` and a "last synthesis {age}" line if the payload has it. |
| BO2 | ux-flow | low | Board card reads `xfdsx → solution-brief, rs, features, tickets` — arrow + comma list is cryptic. | ⚡ Label it: `outputs: solution-brief · rs · features · tickets`; keep arrow-free. |
| BO3 | ux-flow | low | "Discovery sessions" card hides entirely when empty (`sessions?.length>0`) — feature is invisible until sessions exist. | ⚡ Always render the card with an `Empty` state ("no discovery sessions yet — start one from New") — teaches the feature. |
| BO4 | ux-flow | low | Create form: `board` slug free-text with no slugify helper; type select unlabeled visually. | ⚡ Auto-slugify from `name` (kebab-case on input) with manual override; `<span className="field-label">type</span>` beside the select. |
| BO5 | a11y | low | `Field` label association (G9) applies to slug/name/type. | ⚡ `label htmlFor` via Field update. |

### 3.7 `/new` (`screens/CreateImport.tsx`)

Live-verified: dark @1440 — Interview/Import tabs render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| CI1 | a11y | medium | Interview/Import tabs are plain `.tabs button` — no `role=tablist`/`tab`/`aria-selected`. | ⚡ Shared `Tabs` component (G13). |
| CI2 | ux-flow | medium | InterviewTab: after "Interview started" result card — dead end; no "start another" reset; must refresh to run a second interview. | ⚡ Add `Start another` button resetting `result`/`running`. |
| CI3 | ux-flow | medium | `importCommit(workspace, source)` drops `repo`/`milestone`/`labels` from the preview — if the API replays the last preview, fine; if not, commit ignores the user's filters. | ⚡ If the API replays: label the button `"Commit preview"` and note `N issues`. If it doesn't: pass the same filters. Needs API check — flag as a verification item, not an assumption. |
| CI4 | visual | low | Preview cells render `JSON.stringify` — quoted strings (`"foo"`) and object blobs in table cells. | ⚡ `String(v)` for scalars, `JSON.stringify` only for objects/arrays — drops the quotes. |
| CI5 | state-coverage | low | Preview shows rows but no count header or deselect; empty preview handled (`No matching issues`). | ⚡ `N issues matched — commit?` line above the table; keep density. |
| CI6 | a11y | low | `Field` label association (G9). | ⚡ `label htmlFor`. |

### 3.8 `/discovery/:ws/:session` (`screens/DiscoverySession.tsx`)

Code-review only — no live session data during capture (the interview runs failed server-side before creating a session).

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| D1 | visual | medium | Transcript `<ul className="list transcript">` + `msg-user` unstyled → bulleted plain-text list with `[user]`/`[assistant]` brackets. | ⚡ `.transcript{list-style:none;padding:0}` + `.transcript li{padding:8px 0;border-bottom:1px solid var(--border)}`; `.msg-user .chat-role{color:var(--accent)}` (or `.msg-user` text color). |
| D2 | state-coverage | medium | Transcript slices to last 30 with no indicator — earlier turns vanish silently. | ⚡ `Showing last 30 of N turns` line above the list; optional "load more" (structural). |
| D3 | ux-flow | medium | `Complete` sets `status: completed` with no confirm — session-ending action at same weight as `Pause`. | ⚡ Confirm via shared modal; label `"End session"` (clearer than "Complete"). |
| D4 | a11y | medium | Mode tabs partial ARIA (G13); briefing modal lacks focus trap/restore. | ⚡ Shared `Tabs` + shared `Modal` (G7/G13). |
| D5 | state-coverage | low | Understanding panel error → muted "Understanding panel unavailable." — honest but no retry. | ⚡ Add `Retry` button re-calling the understanding fetch. |
| D6 | visual | low | Slot chips `slot: state` (`problem: inferred`) — state readable; value in tooltip only (U5). | ⚡ `aria-describedby` or expandable chip for the value. |
| D7 | ux-flow | low | Bulk mode: sequential POST per line; button label `"Submit N answers"` is the only progress signal; `busy` disables all — good — but mid-submit there's no per-line progress. | ⚡ Update button label during submit: `"Submitting 3/12…"` via a counter in the loop. |
| D8 | copy | low | `skip`/`can't answer`/`n/a`/`defer` lowercase; `can't answer` has a good title tooltip. | ⚡ Sentence-case labels. |

### 3.9 `/features/:ws/:id` (`screens/FeatureWorkspace.tsx`)

Code-review only — no live feature data during capture.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| F1 | bug | high | `.panel`, `.findings`, `.finding`, `.sev-*`, `.feature-workspace` unstyled — Health rail, Acceptance rail, and tab findings render borderless with default bullets. | ⚡ Define the classes (G15): `.panel` card chrome, `.finding` row, `.sev-*` tones. Fixes this screen's entire rail. |
| F2 | visual | low | Page `<h1>` lacks `.page-title` class → renders default h1 size (~32px), inconsistent with the 20px page-title used elsewhere. | ⚡ `className="page-title"` on the h1. |
| F3 | ux-flow | medium | `Accept feature` — the single most important action on the Release tab — renders as a plain secondary `button`. | ⚡ `className="primary"`; add confirm since it gates release assignment (structural if it's a spec'd gate action). |
| F4 | consistency | low | Design-doc names render via `button.link` — `.link` unstyled → looks like a plain button. | ⚡ `.link` rule (G15): `background:none;border:none;color:var(--accent);padding:0;cursor:pointer`. |
| F5 | a11y | medium | Tabs partial ARIA (G13). | ⚡ Shared `Tabs`. |
| F6 | ux-flow | medium | Requirements/AC matrix cells show raw `predicate`/`object`/`valid_at` strings; evidence cells `predicate→object (verification)` are dense. | ⚡ Humanize `predicate` labels (map or `humanize`); wrap `code:` refs in the `Citation` component for provenance. |
| F7 | state-coverage | low | OverviewTab doc 404 → friendly empty — good; tickets grouped by `work_type` with `(n status)` — good. | ⚡ Keep; consider `StatusBadge` for the status inside the group heading. |
| F8 | visual | low | "Ask About This Feature" toggles `ChatEdit` inline above tabs — pushes content down abruptly. | ⚡ Render as a collapsible `details`/drawer with a max-height, or an overlay — keeps layout stable. |

### 3.10 `/tickets/:ws/:id` (`screens/TicketFocus.tsx`)

Live-verified: missing-ticket error state dark @1440 (`Couldn't load ticket` + `not_found` chip). Populated states code-reviewed.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| TF1 | bug | medium | Stale tab selection: if the user is on `review`/`docs`/etc. and the ticket status changes so that tab disappears (SSE or action), `tab` state stays stale — the tab button vanishes and **no pane renders** → blank workbench. | ⚡ `useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]) }, [tabs])`. |
| TF2 | visual | medium | `StatusStepper` renders 16 raw hyphenated chips (`prd-draft`, `ci-watch`…) — machine names, overwhelming width. | ⚡ `STATUS_LABEL` map (G12) + narrower chips; if it's the same concept as the rail `roadmap`, drop the stepper from the header and keep roadmap (dedupe). Verify `StatusStepper` is actually rendered — it may be unused. |
| TF3 | ux-flow | medium | Destructive gates: `Won't do`, `Reject split` — no confirm; `Approve {doc}.md` single-click approves spec docs (approve is the gate's purpose — acceptable). | ⚡ Confirm `wont_do`/`reject_split` via shared modal. |
| TF4 | copy | low | `{doc}.md awaits approval` lowercase; `also open: gate · gate` raw ids; `edit:ab12cd` session id in "AI edit proposal pending". | ⚡ Sentence-case; humanize gate ids; truncate session to `ab12cd` without the `edit:` prefix. |
| TF5 | state-coverage | low | `Question gate open — no question payload.` is an honest dead-end — but the wizard link is below it always; could point directly. | ⚡ Keep; add `Open full wizard` as the primary action inside the empty state. |
| TF6 | a11y | medium | Tabs partial ARIA (G13); `.next-action` accent border card — good pattern. | ⚡ Shared `Tabs`. |
| TF7 | ux-flow | low | Header meta row packs `feature / PR panel / Ledger / Runs` links + `FileCorrection` — link row `.page-sub` fine; the run link labeled `run` is cryptic. | ⚡ `run {shortId}` or `view run ↗`. |

### 3.11 `/tickets/:ws/:id/wizard` (`screens/Wizard.tsx`, `wizard.ts`)

Code-review only — no live ticket.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| W1 | bug | high | Optimistic advance: `onAnswer` sets state **before** the POST confirms — on error the UI shows the next question while the answer was never persisted. A user can "complete" the wizard with silently dropped answers and hit a confusing `submit()` failure. | (structural) Await the POST before advancing; on failure show an inline `"answer not saved — retry"` per-question and keep the current question. Governance data shouldn't lie about state. |
| W2 | ux-flow | medium | `wont-do`/`force-ready` bail-outs — no confirm; `wont_do` navigates immediately. | ⚡ Confirm via shared modal: `"Won't-do this ticket?"` / `"Force ready — skip remaining gates?"`. |
| W3 | a11y | medium | Progress bar `<div aria-label="progress">` — no `role="progressbar"`, `aria-valuenow`, `aria-valuemin/max`. | ⚡ `role="progressbar" aria-valuenow={done} aria-valuemax={total}` + keep visible `x/y` text. |
| W4 | ux-flow | medium | Single/yes-no options submit on first click — no per-question review or undo (only the end `submit()`). A misclick writes a wrong answer. | ⚡ After answering, render an inline `"answered: X"` + `undo`/`back` link (re-POST or revert local state). |
| W5 | copy | nit | `Skip (accept: {default})` — good transparency; bail-outs lowercase hyphenated. | ⚡ `Force ready`, `Won't do` sentence-case. |

### 3.12 `/tickets/:ws/:id/docs/:name` (`screens/DocReview.tsx`)

Code-review only — no live ticket.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| DR1 | ux-flow | medium | `DiffView` renders at the page bottom (below the split layout) regardless of which version pair was clicked — user clicks `v1 → v2` in the right rail, diff appears below the fold. | ⚡ Render the diff inline under the clicked row in the right rail (or a sticky bottom panel); scroll it into view on selection. |
| DR2 | ux-flow | low | `Approve` single click → `done` banner → auto-navigate after 1200ms — no way to stay on the page to keep reviewing the diff. | ⚡ Extend the timeout (3s) or add `stay on page` link in the `done` banner. |
| DR3 | a11y | low | Version buttons `{from} → {to}` — fine but terse. | ⚡ `aria-label="diff version {from} to {to}"`. |
| DR4 | visual | nit | `Versions (N)` card uses `<strong>` header; diff list buttons `v1 → v2` raw. | ⚡ `card-head` styling + `Diff v{from} → v{to}` label. |

### 3.13 `/tickets/:ws/:id/review` (`screens/CodeReview.tsx`)

Code-review only — no live ticket.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| CR1 | ux-flow | high | `Approve → open PR` is enabled regardless of open findings — a single click opens a PR with unresolved blockers. | ⚡ Confirm when `open > 0`: `"N open findings — open PR anyway?"` via shared modal; or disable until `open === 0` if the spec intends hard gating (check spec first — Veto favors human override, so confirm > disable). |
| CR2 | visual | medium | Severity badge maps `nit`/`question` → `spec-warn` (amber) — over-alarming; `minor` → warn too, collapsing distinct severities. | ⚡ `SEV_MAP = { blocker:'spec-bad', major:'spec-bad', minor:'spec-warn', nit:'badge', question:'badge' }` — nit/question neutral. |
| CR3 | copy | low | Verdict buttons lowercase `accept`/`dismiss`/`wontfix` — `wontfix` is jargon. | ⚡ `Accept` / `Dismiss` / `Won't fix`. |
| CR4 | ux-flow | medium | One `busy` flag disables verdict buttons on **all** cards while a single verdict POST is in flight — clicking one finding locks the page. | ⚡ Track busy per `thread_id` (`busyId` state); only that card's buttons disable. |
| CR5 | state-coverage | low | `No findings (or review.json not surfaced yet).` — honest empty state — good. | ⚡ Keep. |
| CR6 | consistency | low | Replies show `actor @ 2026-10-03T14:22` — raw ISO, unlike `fmtAge` elsewhere. | ⚡ `fmtAge` + `title={iso}`. |
| CR7 | ux-flow | nit | `repo:file:line` mono inline in the title — good; could link to `Evidence` `Citation` when a `code:` ref exists. | ⚡ Wrap `code:` refs in `Citation`. |

### 3.14 `/tickets/:ws/:id/pr` (`screens/PrPanel.tsx`)

Code-review only — no live ticket.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| P1 | ux-flow | medium | `Revert` — danger, no confirm. | ⚡ Confirm via shared modal: `"Revert {sha8}?"`. |
| P2 | ux-flow | low | `Merge` is disabled-until-green with `title` tooltip + hint — **good pattern**, replicable. | ⚡ Replicate the "disabled-explains-itself" pattern on `Accept feature`, `End session`, wizard bail-outs. |
| P3 | copy | low | `ci:`/`pr:` badge prefixes raw. | ⚡ `CI:`/`PR:` sentence-case or icon. |
| P4 | state-coverage | low | `run.pr_url` external link — `rel=noreferrer`, same tab — fine. | ⚡ Keep; optionally `target="_blank"`. |
| P5 | ux-flow | nit | `merged {sha8}` — sha shown but not linked. | ⚡ Link to `…/commit/{sha}` when repo url is known. |

### 3.15 `/tickets/:ws/:id/ledger`, `/ledger` (`screens/Ledger.tsx`)

Live-verified: dark @1440 (empty).

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| L1 | ux-flow | medium | `EventCard` expand dumps raw JSON into `.terminal` — opaque for humans; S-11 asks for human-readable log + structured payload. | ⚡ Render known fields as key/value rows (`refs`, `data.*`) + a `raw` toggle for the JSON; keep `.terminal` for the raw view. |
| L2 | copy | medium | `actor_type:actor_id` + raw event names (`gate_surfaced`, `doc_edited`). | ⚡ `EVENT_LABEL` map → `Gate surfaced`, `Doc edited`; `actor` → `type:id` stays mono but split into `actor_type` chip + `actor_id`. |
| L3 | a11y | low | `more/less` lowercase toggle — `aria-expanded` ✓ present. | ⚡ `Details`/`Hide` label + chevron icon (`ChevronDown`/`Up`). |
| L4 | spec-drift | medium | S-11 spec: search, artifact tree, deep links, export — impl has two dropdown filters. | (structural) Add client-side text search + deep-link `?event=` param; artifact tree/export → deferred. |
| L5 | consistency | low | `TicketPicker` cards show `{ws}/{id} — title · {status}` raw status text not `StatusBadge`. | ⚡ `<StatusBadge s={status}/>` in the picker row. |
| L6 | ux-flow | low | `run` link labeled just `run`. | ⚡ `run {shortId}` or `view run ↗`. |
| L7 | state-coverage | low | Events shown as received — no day grouping; `ts.slice(0,19)` raw. | ⚡ `fmtAge` for `ts` + `title={iso}`; optional `Group by day` (structural). |

### 3.16 `/runs`, `/runs/:id` (`screens/RunMonitor.tsx`)

Live-verified: dark/light @1440, narrow @880 — run list renders; run detail shows **both Pause and Kill on a failed run**, transcript shows perpetual "waiting for chunks" placeholder, and `Login canceled` never appears on the page.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| R1 | bug | high | Pause/Kill rendered for terminal statuses — verified live on a `failed` run. | ⚡ Gate controls: render only when `status ∈ {pending, leased, running, paused}`; add a `Retry`/`Requeue` button on terminal failure if the API supports it (deferred if not). |
| R2 | bug | high | Transcript placeholder `(waiting for run_output chunks…)` persists forever on terminal/failed runs — verified live. The actual failure reason (`run.sentinel`, `error`, `Login canceled`) never renders. | ⚡ When `status` is terminal and `!transcript`, show `"run ended — no transcript captured"`; render `run.sentinel`/`error`/`exit_reason` in a `.warn-banner` above the terminal. |
| R3 | ux-flow | medium | Transcript auto-scrolls to bottom on every chunk — can't read history while live. | ⚡ Add a `follow` checkbox (spec asks for "transcript/search/follow"); disable auto-scroll when unchecked; re-enable on scroll-to-bottom. |
| R4 | ux-flow | medium | `Kill` — no confirm; one click kills a running job. | ⚡ Confirm via shared modal: `"Kill run {id}?"`. |
| R5 | a11y | low | `.terminal` autoscrolls via rAF; no `aria-live`/`role`. | ⚡ `role="log" aria-live="off"` (off by default — a live transcript would spam SRs; toggle `polite` when user enables). |
| R6 | visual | low | `.counter .v` token/elapsed counters lack `tabular-nums` — width jitters on tick (G10). | ⚡ `font-variant-numeric: tabular-nums`. |
| R7 | ux-flow | low | No `← runs` breadcrumb on RunMonitor — only screen without a back link. | ⚡ `<Link to="/runs" className="link">← runs</Link>` in `.page-sub`. |
| R8 | consistency | low | Tokens cell `395→15` in→out arrow ambiguous. | ⚡ `title="395 in / 15 out"` or `395 in · 15 out` text. |
| R9 | spec-drift | medium | S-07 spec wants retry/handoff/stronger-model/worktree link/stall-health — impl has Pause/Kill only. | (structural/API) List under deferred; surface `worktree`/`model`/`stall` fields if the payload has them. |
| R10 | ux-flow | low | `op` (pause/kill) has no busy state — double-click possible. | ⚡ Disable the button while its POST is in flight (`busyOp` state). |

### 3.17 `/queue` (`screens/Escalations.tsx`)

Live-verified: dark/light @1440 — filter chips + empty state render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| E1 | ux-flow | medium | `wont-do` — danger, no confirm. | ⚡ Confirm via shared modal. |
| E2 | ux-flow | medium | `retry` vs `resume` both shown — difference unclear (retry last run vs resume pipeline). | ⚡ Clearer labels: `Retry run` / `Resume ticket` + `title` tooltips explaining each. |
| E3 | visual | low | Filter chips `all/failed/…` — good; no per-filter counts. | ⚡ `all (12) · failed (4) · …` counts in the chip label. |
| E4 | copy | low | `reason: {blocked_reason}` lowercase raw. | ⚡ `Blocked: {blocked_reason}`. |
| E5 | copy | low | `retry`/`resume`/`wont-do` lowercase. | ⚡ Sentence-case. |

### 3.18 `/merge-center` (`screens/MergeCenter.tsx`)

Live-verified: dark @1440 — workspace select + empty checklist render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| M1 | a11y | low | Workspace `<select>` visually unlabeled (aria-label only) — Board screen labels it "Workspace". | ⚡ Add `<span className="field-label">project</span>` (spec vocabulary) beside the select for consistency. |
| M2 | ux-flow | low | `Merge now` — significant action; checklist green makes it safe-ish but there's no confirmation. | ⚡ Confirm via shared modal naming the manifest/count: `"Merge N tickets into {target}?"`. |
| M3 | consistency | low | `✓`/`✗` text glyphs vs. lucide icons elsewhere — mixed iconography. | ⚡ Use lucide `Check`/`X` (16px) for checklist rows; or accept glyphs consistently — pick one. |
| M4 | state-coverage | low | `evaluated {age} ago` — good; heads sha row fine. | ⚡ Keep. |
| M5 | ux-flow | low | Conflict card links to ticket — good pattern. | ⚡ Keep. |

### 3.19 `/releases`, `/releases/:ws/:rel` (`screens/ReleaseCenter.tsx`)

Live-verified: dark @1440 (list, empty); detail code-reviewed. The most mature surface — digest-bound approvals, honest gate states.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| RC1 | ux-flow | medium | Scope-item `remove` — `small danger`, no confirm; post-freeze removal recuts the manifest — consequential. | ⚡ Confirm via shared modal: `"Remove {item} from scope — recuts manifest?"`. |
| RC2 | a11y | low | Workspace `<select>` visually unlabeled (same as MergeCenter). | ⚡ `project` label. |
| RC3 | ux-flow | low | Add-item `item_id` free text — no autocomplete/picker; placeholder-only hint. | ⚡ `placeholder="F-0001 or SR-1234"` + `aria-label="item id"`; picker = deferred/API. |
| RC4 | visual | low | Manifest digest `slice(0,16)…` mono — fine; `latest` badge good. | ⚡ Keep. |
| RC5 | ux-flow | low | `Awaiting human approval — Gates tab →` is text pointing to a tab — doesn't switch it. | ⚡ Make it a link/button that `setTab('gates')`. |

### 3.20 `/metrics` (`screens/Metrics.tsx`)

Live-verified: dark @1440 — counters, funnel, gates, events table render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| ME1 | a11y | low | Workspace `<select>` visually unlabeled. | ⚡ `project` label. |
| ME2 | visual | medium | 8 counters row — `.counter .v` is 18px/700 — good; but no `tabular-nums` (G10); funnel/gates render raw status keys. | ⚡ `tabular-nums` on `.v`; `STATUS_LABEL` map on funnel keys + gate names. |
| ME3 | state-coverage | low | Events table `slice(0,20)` silent truncation — no "+N more" footer. | ⚡ `Showing 20 of N` footer row. |
| ME4 | state-coverage | low | No "as of" timestamp or Refresh — metrics load once; staleness invisible. | ⚡ `updated {age} ago` line + `Refresh` button re-calling `load()`. |
| ME5 | ux-flow | nit | Funnel/gates rows are dead data — could link to `/queue` or filtered ticket lists. | ⚡ Link gate names to `/queue?gate={name}` (if the filter supports it; structural if not). |

### 3.21 `/workspaces` (`screens/Workspaces.tsx`)

Live-verified: dark @1440 — list + add form render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| WS1 | spec-drift | medium | S-13 spec wants cards with health/repos/dossier/boards + archive/remove — impl = name/path + 2 badges + add form. | (structural/API) Extend payload with health/board counts (deferred); ⚡ render repos as a `field-label` list inside the card. |
| WS2 | ux-flow | low | No archive/remove affordance — a workspace added by mistake is a dead end. | (structural/API) `Archive` action — deferred if API lacks it. |
| WS3 | ux-flow | low | Add form — no client-side validation (name chars, path scheme); errors surface via `ErrorBox` raw. | ⚡ Basic `pattern`/required on inputs + friendly error (G21 upgrade). |
| WS4 | copy | low | `Tickets repos this conductor serves` — jargon; unclear what the screen manages. | ⚡ `Projects (tickets repos) this conductor serves` + a one-line helper. |
| WS5 | a11y | low | `Field` label association (G9). | ⚡ `label htmlFor`. |

### 3.22 `/kb` (`screens/KnowledgeBase.tsx`)

Live-verified: dark @1440 — dossier picker + scope tabs render.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| K1 | bug | high | `SectionEditor` `useState(entry.content)` never resets when the `entry` prop changes — switching sections mid-edit keeps the stale draft; Save writes section A's text into section B. | ⚡ `key={entry.section}` on `<SectionEditor>` (forces remount per section) or `useEffect(() => setDraft(entry.content), [entry.section])`. |
| K2 | a11y | medium | Scope tabs + section tabs are plain `.tabs button` — no roles/aria. | ⚡ Shared `Tabs` (G13). |
| K3 | ux-flow | medium | Missing-section marker is a `·` suffix on the tab label — cryptic glyph. | ⚡ `title="not surveyed yet"` on the tab + a dimmed dot icon (`Circle` 8px) or `badge`-class marker. |
| K4 | ux-flow | medium | Edit → `Cancel` discards edits silently — no dirty-check. | ⚡ If `draft !== entry.content`, confirm `Discard edits?`. |
| K5 | ux-flow | medium | `Sync` button says nothing about what it does; `syncMsg "survey run queued: {run}"` doesn't link to the run. | ⚡ `title="queue a survey run"` + link `survey run {shortId} →` to `/runs/{run}`. |
| K6 | spec-drift | medium | S-14 wants code tab, traceability tab, gap-report dispositions/create-board-item, search — impl = dossier sections + gap tab only. | (structural) List under deferred; gap-report items could get a `dismiss`/`create board item` action if the API supports it. |
| K7 | visual | low | Dossier picker renders a `.card` wrapping a full-width button — two nested boxes. | ⚡ Use a `.tray-row`-style list of section rows instead of card+button. |

### 3.23 `/settings` (`screens/Settings.tsx`)

Live-verified: dark/light @1440, narrow @880 — tabs, fields, repo cards render; "Merge & UI" tab has no theme control.

| # | Tag | Severity | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| S1 | ux-flow | medium | Save bar sits at page bottom — an unsaved draft is invisible while scrolled to a field; no warn-on-leave. | ⚡ Sticky footer `.save-bar{position:sticky;bottom:0;background:var(--bg);padding:8px 0}` + `N unsaved changes` chip in the header; `beforeunload` warning on dirty. |
| S2 | bug | medium | `Discard changes` only appears when `draft` is non-null — a secrets-only edit enables Save but hides Discard (can't undo a pending secret change). | ⚡ Show Discard when `draft !== null || pendingSecrets` (track secrets-dirty alongside draft-dirty). |
| S3 | spec-drift | medium | S-02 spec scope: first-run checklist, Projects, notifications, worktrees, boards/synthesis, verification, survey cadence, evidence, security, telemetry — impl covers ~40%. Plus `ui.theme` exists in SETTINGS spec but there's no control (G19). | (structural) Fill remaining spec sections + theme select (G19); checklist = deferred. |
| S4 | copy | low | snake_case labels (`permission_mode`, `storage_url`, `main_model`) — machine keys as UI text. | ⚡ Humanize labels (`Permission mode`, `Storage URL`, `Main model`); keep the raw key as a muted secondary caption if needed. |
| S5 | ux-flow | low | `Products` renders a raw JSON dump — read-only, unexplained. | ⚡ Wrap in `<details>` or a `field-label` + helper (`"managed products — read-only"`). |
| S6 | state-coverage | low | Number fields: no min/max/help text; empty→`null` delete is good but silent. | ⚡ `min`/`max`/`step` on numeric inputs + helper text for budget units (`"USD/month"`). |
| S7 | ux-flow | low | `RepoAdder` writes into draft silently — the new repo card renders immediately (draft-driven) but there's no "unsaved" marker on it. | ⚡ `.badge` `unsaved` on the new repo card until Save lands. |
| S8 | a11y | low | `Field` label association (G9) — ~30 fields affected. | ⚡ `label htmlFor`. |

---

## 4. Cross-screen recommendations

Ordered by leverage.

1. **Define the dead class hooks** (G15) — `.list`, `.panel`, `.link`,
   `.dim`, `.findings`, `.finding`, `.sev-*`, `.citation`,
   `.accept-box`, `.alignment-panel`, `.align-finding`, `.align-refs`,
   `.discovery-main`, `.feature-workspace`, `.page`, `.compact`,
   `.chat-line`, `.chat-*`, `.msg-user`, `.spec-dim`. One CSS pass
   (~60–80 lines) repairs default bullets, invisible links, borderless
   panels, and identical severity badges across ~15 components.
   *⚡ highest leverage.*
2. **Complete the badge/label system** — `.status-*` tone map (G2),
   `STATUS_LABEL`/`KIND_LABEL`/`GATE_LABEL`/`PRIORITY_LABEL` maps (G12),
   `.sev-*` distinct tones (CR2). Fixes every badge + most machine-copy.
3. **Shared `Modal` + `ConfirmDialog`** (G7) — focus trap, restore,
   `aria-modal`, `showModal()`; wire into capture modal, board
   drop-confirm, briefing, ledger picker, KB confirm, and every
   destructive action (T1, D3, R4, P1, RC1, W2, E1, M2).
4. **Shared `Tabs`** (G13) — full ARIA + arrow keys; replace every
   `.tabs` block (Home, TicketFocus, Settings, ReleaseCenter,
   DiscoverySession, KB, CreateImport).
5. **Global `:focus-visible` + motion rules** (G4/G5) — one CSS block;
   reduced-motion guard.
6. **`ErrorBox` upgrade** (G21) — friendly map, `code` chip, optional
   retry/dismiss; standardize at call sites.
7. **Toast/channel unification** (G6/G8) — fix z-index, then route
   warn-banners/inline success through one system or split clearly
   (`banner` component for persistent, `toast` for transient).
8. **`Field` label association** (G9) — `label htmlFor` via `id` prop;
   ~40 call sites benefit.
9. **Missing global chrome** (G18/G19) — connection/live-state
   indicator, `?` shortcut help, ⌘K palette (deferred), notification
   popover (deferred), theme select (Settings).
10. **Narrow-width breakpoints** (G20) — `.split`/`.tray-layout`/
    `.discovery-layout`/`.board` stack below ~720px; `.main` padding
    shrinks; preserve density (stack, don't pad).

---

## 5. Deferred items

Explicit list — not silently dropped. Each needs an API change,
state-model change, new dependency, or component restructure beyond
markup/CSS.

- **Inbox `title`/summary in the payload** (I1) — `api.inbox()` needs to
  return a human title per item; UI can then render it.
- **Boards list counts** (BO1) — `open/consumed/shipped/parked/stale`,
  tray count, `last_synthesis` per board — `api.boards()` payload
  extension.
- **Workspaces health/repos/dossier/boards + archive** (WS1/WS2) —
  `api.workspaces()` payload + an archive/remove endpoint.
- **Run retry/handoff/stronger-model/worktree/stall-health** (R9) —
  S-07 spec — needs `api.runs` actions/fields.
- **Ledger search, artifact tree, deep links, export** (L4) — S-11 —
  client-side search is markup-only; tree/export need API.
- **KB code tab, traceability tab, gap dispositions, search** (K6) —
  S-14 — needs `api.kb()` extensions + UI tabs.
- **⌘K command/search palette** (G18) — global state, command registry,
  search API (WF-23) — a feature build.
- **Notification popover + mark-read** (G18) — `api.events` surfacing +
  UI panel.
- **Actor identity / settings-aware chrome** (G18) — global scope
  context.
- **Settings remaining spec sections** (S3) — first-run checklist,
  notifications, worktrees, verification, evidence, telemetry — needs
  config endpoints/UI.
- **`importCommit` filter passthrough verification** (CI3) — confirm
  whether the API replays the last preview; if not, pass filters.
- **`StatusStepper` usage** (TF2) — verify whether the component is
  rendered; if unused, delete or wire it.
- **Keyboard-alternative DnD** (B1) — per-card move menu — markup +
  menu component (quick-ish but structural).
- **Transcript "load more"** (D2) — pagination or lazy load.

---

## 6. Coverage checklist

Every in-scope route + shared surface, and how it was verified.

| Route / surface | Verified |
| --- | --- |
| `/` Home (Board + Inbox + UnderstandingPanel) | code-review + live (dark/light @1440, narrow @880) |
| `/boards` list | code-review + live (dark @1440) |
| `/capture` + ⌘⇧C modal | code-review + live (dark/light @1440, narrow @880); modal code-review only |
| `/tray` | code-review + live (dark/light @1440, narrow @880) |
| `/new` CreateImport | code-review + live (dark @1440) |
| `/discovery/:ws/:session` | code-review only (no live session data) |
| `/features/:ws/:id` | code-review only (no live feature data) |
| `/tickets/:ws/:id` | code-review + live error state (dark @1440, missing ticket) |
| `/tickets/:ws/:id/wizard` | code-review only |
| `/tickets/:ws/:id/docs/:name` | code-review only |
| `/tickets/:ws/:id/review` | code-review only |
| `/tickets/:ws/:id/pr` | code-review only |
| `/tickets/:ws/:id/ledger`, `/ledger` | code-review + live (dark @1440, empty) |
| `/runs` | code-review + live (dark/light @1440) |
| `/runs/:id` | code-review + live (dark @1440, narrow @880) |
| `/queue` | code-review + live (dark/light @1440) |
| `/merge-center` | code-review + live (dark @1440, empty) |
| `/releases`, `/releases/:ws/:rel` | list: code-review + live (dark @1440); detail: code-review only |
| `/metrics` | code-review + live (dark @1440) |
| `/workspaces` | code-review + live (dark @1440) |
| `/kb` | code-review + live (dark @1440) |
| `/settings` | code-review + live (dark/light @1440, narrow @880) |
| Global chrome (nav, badge, toasts, modal, Escape) | code-review + live (toasts/modal code-review only for open states) |
| `components.tsx`, `ChatEdit`, `Evidence`, `Alignment`, `RsQuality`, `Traceability` | code-review |

**Excluded (per scope):** `/boards/:ws/:board` (idea-board canvas),
`screens/IdeaBoard.tsx`, `src/board-canvas/`, `src/demo/`, `dist/`,
tests, backend/API design.

---

*Audit completed from source + live captures at 1440×900 (dark/light)
and 880×900 (narrow). Two expected 404s observed (missing-ticket route
and favicon); no horizontal overflow at any captured width. Zero code
changes were made.*
