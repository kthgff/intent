/**
 * UI token bootstrap (API.md "Auth — always on, no exceptions").
 *
 * The token is a 32-byte random hex string generated on first launch
 * and written to `ui.token_file` (default
 * `~/.config/sprint-runner/ui-token`, mode `0600`). It is never
 * logged, never committed, never echoed by the API — callers treat the
 * return value as a secret.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Read `path` if it already holds a valid token; otherwise generate
 * one, write it mode `0600`, and return it. Throws when the file
 * exists but is malformed (fail-closed — a truncated token file means
 * someone's edits would be silently ignored if we overwrote it).
 */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (TOKEN_RE.test(existing)) {
      // Re-assert mode — the file may have been copied with loose perms.
      chmodSync(path, 0o600);
      return existing;
    }
    throw new Error(
      `ui token file ${path} exists but is malformed (expected 64 hex chars)`,
    );
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}
