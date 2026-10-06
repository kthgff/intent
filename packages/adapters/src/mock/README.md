# MockAdapter — scripted test backend (wp-021)

The mock backend for conductor tests/E2E: `run()` spawns a **real
detached child process** (`node agent.mjs`, pure Node, shipped here)
that emits scripted behavior. Real pid, real log file, real POSIX
signals — zero LLM spend.

## Scenario DSL (`MOCK_SCENARIO`)

| Scenario | Behavior | Last line (sentinel) |
| --- | --- | --- |
| `done` (default) | writes `result.json` artifact | `DONE` |
| `blocked:<reason>` | writes `result.json` | `BLOCKED: <reason>` |
| `needs-info:<n>` | writes `result.json` | `NEEDS-INFO: <n>` |
| `garbage-sentinel` | no artifacts | `?? this is not a sentinel at all !!` (malformed) |
| `no-sentinel` | exits silently (heartbeat noise only) | — missing |
| `hang` | never exits — timeout/kill tests | — |
| `fail-lint` | writes malformed `review.json` | `DONE` |
| `usage` | emits `USAGE`/`USAGE_TOTAL` lines + `result.json` | `DONE` |
| `artifacts:<json>` | writes `{"relpath": "content"}` map into ARTIFACT_TARGETS | `DONE` |

Unknown scenarios exit 2 with `BLOCKED: unknown mock scenario '<x>'`.

## Child env vars

| Var | Meaning |
| --- | --- |
| `MOCK_SCENARIO` | scenario DSL above |
| `MOCK_ARTIFACT_DIR` | artifact target dir (from the rendered prompt's `ARTIFACT_TARGETS`, or explicit `MockRunOptions.artifactDir`) |
| `MOCK_DELAY_MS` | work delay before the sentinel (heartbeat coverage) — default 50 |
| `MOCK_HEARTBEAT_MS` | interval for `HEARTBEAT <iso>` noise lines; the log mtime is the conductor-observed heartbeat — default 100, 0 disables |
| `MOCK_TIMEOUT_S` | self-timeout → exit 124 with no sentinel (adapter passes `run()`'s `timeout` arg; 0 = off) |
| `MOCK_IGNORE_TERM` | `1` → ignore SIGTERM (exercises the SIGKILL-after-grace path) |

## Usage line format (parsed by `collect()` / `on_usage()`)

```
USAGE {"tokens_in":n,"tokens_out":n,"tokens_cached":n}
USAGE_TOTAL {"tokens_in":n,"tokens_out":n,"tokens_cached":n,"cost_usd":n|null}
```

- `USAGE` lines → `calls[]` (`per-call` granularity, `source: reported`).
- `USAGE_TOTAL` → run totals override.
- No usage lines → `source: estimated` (labeled estimate from prompt/log
  size — never fails the run, per ADAPTERS failure mapping).

## Collect semantics

- Waits for the detached child to exit.
- Last **non-empty** log line → sentinel NAME (token before `:`); must be
  a known CONDUCTOR sentinel or `sentinel: null` (`sentinel_raw` keeps
  the line) → conductor maps to `run_failed`.
- Artifacts: listed from `ARTIFACT_TARGETS`. When the target is a
  worktree-relative `.veto/<run-id>/` scratch dir
  (`can_write_outside_tree: false`), collect copies it into
  `ctx.run_dir` and purges the scratch dir — the diff never sees it.

## Signals (`control()`)

- `kill` → SIGTERM, then SIGKILL after `killGraceMs` (default 500ms).
- `pause` → SIGSTOP; `resume` → SIGCONT.

## Example

```ts
const adapter = new MockAdapter({ scenario: 'usage' });
const rendered = adapter.prepare('SR-0001', 'implement', ctx);
const handle = adapter.run('/path/to/worktree', rendered, 30);
adapter.on_usage(handle, (u) => console.log('partial', u));
const result = await adapter.collect(handle, collectCtx);
// result.sentinel === 'DONE', result.artifacts, result.usage
```
