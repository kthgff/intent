/**
 * dotenv-style `.env` parsing — SETTINGS.md "Secrets".
 * Secrets live ONLY in .env files / env vars. Values are NEVER included
 * in warnings or error messages — only key names may be surfaced.
 */

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const DQUOTED_RE = /^"((?:[^"\\]|\\.)*)"/;
const SQUOTED_RE = /^'((?:[^'\\])*)'/;

function unescapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Parse dotenv-style content into a key/value map.
 * Supports: `KEY=value`, optional `export ` prefix, single/double-quoted
 * values (double-quoted values support \\n, \\t, \\r, \\", \\\\ escapes),
 * `#` comments on their own line or trailing unquoted values, blank
 * lines.
 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    let value: string;
    const dq = DQUOTED_RE.exec(rest);
    const sq = SQUOTED_RE.exec(rest);
    if (dq) {
      value = unescapeDoubleQuoted(dq[1] as string);
    } else if (sq) {
      value = sq[1] as string;
    } else {
      // unquoted — strip trailing comment
      const hash = rest.indexOf(' #');
      value = (hash === -1 ? rest : rest.slice(0, hash)).trimEnd();
    }
    out[key] = value;
  }
  return out;
}
