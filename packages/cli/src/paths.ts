/**
 * paths.ts — filesystem layout for the CLI (wp-099).
 *
 * Product naming is `veto` everywhere on disk (wp-100 rename —
 * binary, config dir, package scopes).
 *
 *   ~/.config/veto/config.yaml   global config (SETTINGS.md)
 *   ~/.config/veto/.env          secrets
 *   ~/.config/veto/ui-token      UI bearer token (0600)
 *   ~/.local/share/veto/workspaces/<name>   workspace roots
 *   ~/.local/share/veto/runs/<ws>/<subject>/<NNN>-<stage>/  run dirs
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGlobalConfigPath } from '@veto/config';

/** `~/.config/veto/config.yaml` (SETTINGS.md). */
export function globalConfigPath(): string {
  return defaultGlobalConfigPath();
}

/** Directory holding config.yaml/.env/ui-token — follows `--config`. */
export function configDir(
  configPath: string = defaultGlobalConfigPath(),
): string {
  return dirname(configPath);
}

/** Local data root — matches the API POST /workspaces default pathing. */
export function dataDir(): string {
  return join(homedir(), '.local', 'share', 'veto');
}

export function workspacesDir(): string {
  return join(dataDir(), 'workspaces');
}

/** Default workspace root for a project registered without an
 *  explicit path — same derivation as POST /workspaces (server.ts). */
export function defaultWorkspaceRoot(name: string): string {
  return join(workspacesDir(), name);
}

/** Root for `<ws>/<subject>/<NNN>-<stage>/` run dirs (transcripts +
 *  logs — structured output lives in `run_artifacts`, DB-SCHEMA). */
export function runsDir(): string {
  return join(dataDir(), 'runs');
}

/**
 * Resolve the built UI bundle (`packages/ui/dist` — vite build output,
 * served static by the API package per wp-099). `--ui-dist` and
 * `SR_UI_DIST` override for dev/packaging. Returns null when no build
 * is present — the daemon still boots and serves the placeholder.
 */
export function resolveUiDist(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.SR_UI_DIST,
    // packages/cli/{src,dist}/ → packages/ui/dist
    fileURLToPath(new URL('../../ui/dist', import.meta.url)),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}
