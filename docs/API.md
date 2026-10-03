# API — conductor UI surface contract

Companion to `CONDUCTOR.md`. Draft 2026-10-03.
The conductor serves the web UI over HTTP on `ui.bind`:`ui.port`
(default `127.0.0.1:4711`). One surface — the desktop shell's webview
and any browser (daemon mode) hit the identical API. Wire protocol:
**REST + SSE**. This doc pins auth, resources, and the live channel;
payload shapes come from `SCHEMAS.md`/`DB-SCHEMA.md`.

## Auth — always on, no exceptions

- Every request requires `Authorization: Bearer <token>` — API calls,
  SSE connections, and static assets alike.
- Token: 32-byte random hex, generated on first launch, written to
  `ui.token_file` (default `~/.config/sprint-runner/ui-token`,
  mode `0600`). Never logged, never committed, never echoed by the API.
- The desktop shell reads the token file and injects the header into
  webview requests. Browser/daemon users bootstrap once via
  `GET /?token=<token>` on `127.0.0.1` → server sets a session cookie;
  the query-param path is **refused on non-loopback binds**.
- `ui.remote_access: true` widens `bind`; the token is still required
  on every request including the SSE stream, and config warns on save.
  Rationale (unchanged from CONDUCTOR): agents on this machine execute
  arbitrary code — an unauthenticated localhost surface is a
  CSRF→RCE door.

## Conventions

- Base path `/api/v1` · JSON bodies · errors `{error, message, refs?}`
  with 4xx/5xx.
- Ids are workspace-qualified: `ticket_ref` = `<workspace>/<ticket_id>`
  on anything that touches a ticket (`SR-NNNN` is unique per
  tickets-repo only — see DB-SCHEMA workspace keying).
- Gate writes carry `expected_status` and are idempotent — a stale
  submission (another install cleared the gate first) gets `409`, not
  a double-commit. Claims/leases make collisions visible; this makes
  them safe.

## Resources

| Path | Verbs | Backs |
| --- | --- | --- |
| `/inbox` | GET | S-01 — unified `gate_items`, ranked blocking-first → priority → age; `?workspace=` filter |
| `/tickets` | GET | S-01/S-05 lists — `tickets` projection (filters: status, repo, workspace) |
| `/tickets/<ref>` | GET | S-05 — projection + ticket.md + triage + family rail |
| `/tickets/<ref>/docs/<name>` | GET | S-06 — rendered prd/tdd/test + version diffs |
| `/tickets/<ref>/events` | GET | S-05 Activity / S-11 ledger slice |
| `/tickets/<ref>/answers` | POST | S-04 wizard answers (single or batch) → commit → re-run |
| `/tickets/<ref>/docs/<name>/feedback` | POST | S-06 comment → `doc_feedback` → revision run |
| `/tickets/<ref>/docs/<name>/approve` | POST | S-06 approve → `doc_approved` (+ merges mirror PR) |
| `/tickets/<ref>/findings/<fid>/verdict` | POST | S-08 accept / dismiss / wontfix |
| `/tickets/<ref>/actions` | POST | `go_implement` (spend checkpoint), `open_pr`, `merge`, `revert`, `send_back`, `force_ready`, `wont_do`, `handoff`, `resume`, `retry`, `approve_split` |
| `/runs`, `/runs/<id>` | GET | S-07 monitor — registry + artifact listing |
| `/runs/<id>/kill` `/pause` `/resume` | POST | SIGTERM→SIGKILL / SIGSTOP / SIGCONT |
| `/workspaces` | GET, POST | S-13 — tickets repos + per-repo queue counts; add |
| `/interview` | POST | S-03 — seed text → interview run |
| `/import` | POST | S-03 — source + query → preview rows → commit |
| `/settings` | GET, PUT | S-02 — config.yaml fields; secrets are write-only (never read back) |
| `/kb/<scope>` | GET, PUT | S-14 dossier sections; PUT = human edit → `dossier_edited` |
| `/kb/<scope>/sync` | POST | manual survey run |
| `/metrics` | GET | S-12 — dashboard aggregates from `events_idx`/`usage_calls` |
| `/gate-items/<id>/claim` `/release` | POST, DELETE | shared-queue claiming |

## Live channel — `GET /api/v1/stream` (SSE)

One event source per client:

| event | payload | drives |
| --- | --- | --- |
| `gate_surfaced` / `gate_cleared` | gate_item row | S-01 inbox, badge counts |
| `run_status` | run row delta | status steppers, monitor |
| `run_output` | `{run_id, chunk}` | S-07 transcript tail |
| `usage_partial` | `{run_id, tokens_in, tokens_out, tokens_cached}` | live counters — internal stream, **not** a ledger event (SCHEMAS §7) |
| `notification` | notification row | desktop toasts |

Every streamed fact is also written durably (events.jsonl, DB rows,
log files) — the stream is a latency optimization, never the only
copy; a reconnecting client re-reads state, no replay protocol needed.
