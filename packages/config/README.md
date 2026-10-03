# @sprint-runner/config

Layered configuration loader implementing `docs/SETTINGS.md`.

## Precedence (highest wins)

1. ticket frontmatter overrides (`resolveConfig` first arg)
2. `<tickets-repo>/.sprint-runner/config.yaml`
3. `~/.config/sprint-runner/config.yaml`
4. defaults (zod schema + SETTINGS-literal tables: `DEFAULT_TIMEOUTS`,
   `DEFAULT_CAPABILITIES`, `ui.token_file`, importer `token_env`s)

## API

```ts
const global = loadGlobalConfig();                  // or loadGlobalConfig(path)
const ws = loadWorkspaceConfig(ticketsRepoPath, global);
const eff: EffectiveConfig = resolveConfig(ticketFrontmatter, ws);
eff.warnings;   // e.g. ui.remote_access:true notice
eff.secrets;    // merged .env map — never log values
```

Frontmatter keys map onto config: `model` → `main_model`, `backend` →
`backend`, `depth` → `spec_depth`; any other key matching a config path
is a direct override. Ticket metadata keys are ignored.

## Failure modes (fail-closed)

- Unknown config keys → `ConfigError` listing offending + valid paths.
- Malformed values → `ConfigError` with zod issue paths.
- Missing `actor` → `ConfigError` explaining how to set it.
- Secret **values** never appear in warnings or error messages.

## Secrets

`.env` files sit next to each `config.yaml` (global dir and
`<tickets-repo>/.sprint-runner/`). Parsed dotenv-style: `KEY=value`,
`export` prefix, single/double quotes, `#` comments. Repo secrets
override global ones.
