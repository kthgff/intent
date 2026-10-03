/**
 * aider stdout token-usage parsing → SCHEMAS §13 per-call usage.
 *
 * The exact aider usage-line format is UNVERIFIED (spike 2026-10-03 —
 * no aider/pipx/uvx on the machine; see ADAPTERS.md "Aider adapter —
 * spike notes"). Documented forms include:
 *
 *   Tokens: 12.3k sent, 980 received.
 *   Tokens: 4.1k sent, 1.2k received. Cost: $0.04 message, $0.31 session.
 *   Tokens: 2.0k cache hits, 512 sent, 88 received.
 *
 * The parser is therefore defensive: several patterns, k/M numeric
 * suffixes, optional cache/cost hints. A line that matches nothing
 * yields `null` — the caller simply doesn't call back; usage
 * extraction NEVER fails the run (ADAPTERS failure-mapping).
 */
import type { UsagePartial } from '@sprint-runner/core';

/** Parsed per-message usage; `cost`/`sessionCost` are parsed for the
 *  ledger but never trusted over the local price table (§13 — cost is
 *  computed, not echoed). */
export interface AiderUsageLine extends UsagePartial {
  /** Per-message cost aider printed, if present (informational). */
  messageCostUsd?: number;
}

/** `12.3k` → 12300; `980` → 980; `1,200` → 1200; `2M` → 2_000_000. */
export function parseTokenCount(raw: string): number | null {
  const m = raw.trim().match(/^([\d,]+(?:\.\d+)?)([kKmM])?$/);
  if (m === null || m[1] === undefined) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  return Math.round(base * mult);
}

const NUM = '([\\d,]+(?:\\.\\d+)?[kKmM]?)';

// Pattern set — tried in order; first full match wins. Each must
// capture at least input(sent) and output(received) counts.
const PATTERNS: RegExp[] = [
  // "Tokens: 12.3k sent, 980 received." / "... Cost: $0.04 message, ..."
  new RegExp(
    `Tokens?:\\s+(?:${NUM}\\s+cache[^,]*,\\s*)?${NUM}\\s+sent,?\\s+${NUM}\\s+received`,
    'i',
  ),
  // "sent 12.3k tokens, received 980" / "prompt 4k, completion 512"
  new RegExp(`sent\\s+${NUM}\\s+tokens?[^\\d]+received\\s+${NUM}`, 'i'),
  new RegExp(
    `prompt(?:_tokens)?:\\s*${NUM}[^\\d]+completion(?:_tokens)?:\\s*${NUM}`,
    'i',
  ),
  new RegExp(
    `input(?:_tokens)?:\\s*${NUM}[^\\d]+output(?:_tokens)?:\\s*${NUM}`,
    'i',
  ),
];

const CACHE_HIT_RE = new RegExp(
  `${NUM}\\s+cache(?:\\s*[- ]?(?:hit|read))?`,
  'i',
);
const COST_RE = /Cost:\s*\$(\d+(?:\.\d+)?)\s+message/i;

/**
 * Parse one stdout line → per-message {@link AiderUsageLine}, or null
 * when the line isn't a recognized usage line. Never throws.
 */
export function parseAiderUsageLine(line: string): AiderUsageLine | null {
  for (const re of PATTERNS) {
    const m = line.match(re);
    if (m === null) continue;
    // Capture groups: for pattern 1 there may be a leading cache count;
    // sent/received are always the LAST two groups.
    const groups = m.slice(1).filter((g): g is string => g !== undefined);
    if (groups.length < 2) continue;
    const sent = parseTokenCount(groups[groups.length - 2] as string);
    const received = parseTokenCount(groups[groups.length - 1] as string);
    if (sent === null || received === null) continue;

    let tokens_cached = 0;
    if (groups.length > 2) {
      tokens_cached = parseTokenCount(groups[0] as string) ?? 0;
    } else {
      const cache = line.match(CACHE_HIT_RE);
      if (cache?.[1] !== undefined) {
        tokens_cached = parseTokenCount(cache[1]) ?? 0;
      }
    }

    const out: AiderUsageLine = {
      tokens_in: sent,
      tokens_out: received,
      tokens_cached,
    };
    const cost = line.match(COST_RE);
    if (cost?.[1] !== undefined) {
      const c = Number(cost[1]);
      if (Number.isFinite(c)) out.messageCostUsd = c;
    }
    return out;
  }
  return null;
}
