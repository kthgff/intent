# Theming — light + dark mode

D34 (2026-10-04). The UI ships both themes; every component renders
correctly in either. Palette is token-based — screens NEVER hardcode
hex; they consume the CSS custom properties below (already the
convention in `packages/ui/src/styles.css`).

## Mechanism

- Tokens live on `:root`/`[data-theme]` in `styles.css`; dark is the
  default, `[data-theme="light"]` overrides.
- `ui.theme: system | dark | light` (SETTINGS) — `system` follows
  `prefers-color-scheme` (live; an OS toggle restyles without reload).
- An inline script in `index.html` resolves the theme before first
  paint (no flash of wrong theme); the resolved value is persisted in
  `localStorage["veto.theme"]` and applied via
  `documentElement.dataset.theme`.
- `color-scheme` is set per theme so scrollbars/form controls match.
- The desktop shell reads the same pref for its chrome (titlebar
  blending, dock badge legibility) — spec-level for now.

## Palette (semantic tokens)

| Token | Role | Dark | Light |
| --- | --- | --- | --- |
| `--bg` | page background | `#0e1116` | `#f6f8fa` |
| `--bg-raised` | cards, rails, headers | `#161b22` | `#ffffff` |
| `--bg-hover` | hover/active fills | `#1c232e` | `#eaeef2` |
| `--border` | strokes, dividers | `#2a3340` | `#d1d9e0` |
| `--text` | primary text | `#d6dee8` | `#1f2328` |
| `--text-dim` | secondary text, placeholders | `#8b98a8` | `#59636e` |
| `--accent` | links, focus, primary actions | `#58a6ff` | `#0969da` |
| `--green` | pass/merged/success | `#3fb950` | `#1a7f37` |
| `--yellow` | warn/attention/pending | `#d29922` | `#9a6700` |
| `--red` | fail/blocker/danger | `#f85149` | `#d1242f` |
| `--purple` | review/agent/misc accent | `#bc8cff` | `#8250df` |

Rationale: dark palette is GitHub-dark-flavored (what wp-080 shipped);
light mirrors GitHub-light — same semantic roles, familiar mapping,
WCAG AA contrast for `--text`/`--text-dim` on both backgrounds.

## Rules

- Status colors are semantic, not decorative — `green|yellow|red`
  mean pass/warn/fail everywhere (badges, dots, CI, sentinels).
  Never use accent for status or status colors for chrome.
- Attention badges use `--yellow` ring + `--red` dot for failures;
  severity inherits the same ramp (blocker=red, major=yellow,
  minor=dim, nit=dim-italic, question=accent).
- Board stickies keep their 6 fixed hues in both themes; desaturate
  ~15% in light mode for text contrast — sticky *fill* is content
  color, sticky *text* uses `--text`.
- Elevation is conveyed by `--bg-raised` + `--border`, not shadows —
  shadows allowed only for overlays/popovers.
- Charts/metrics (S-12) read the token values at render time —
  no baked-in colors.
- New tokens require: both values defined, contrast note, and a row
  in this table — one edit, never per-screen divergence.

## Follow-ups

- Light-mode mockup variants for S-01–S-14 renders (current PNGs are
  dark-only).
- Themed `theme-color` meta swap (currently dark-fixed `#0b0d10`).
