/**
 * devin `--export` usage extraction → SCHEMAS §13 usage.json shape.
 *
 * The real export schema is UNKNOWN (spike 2026-10-03 — auth blocked,
 * no real export produced; see ADAPTERS.md findings). The parser is
 * therefore defensive: it recognizes several plausible token-field
 * spellings at several plausible locations, and falls back to
 * `source: estimated` when the export carries nothing. Usage
 * extraction NEVER fails the run (ADAPTERS failure-mapping).
 */
import { readFileSync } from 'node:fs';
import type { Usage } from '@sprint-runner/core';

/** Rough chars-per-token for the estimation fallback (no tokenizer dep). */
const CHARS_PER_TOKEN = 4;

const IN_KEYS = ['tokens_in', 'input_tokens', 'prompt_tokens', 'input'];
const OUT_KEYS = ['tokens_out', 'output_tokens', 'completion_tokens', 'output'];
const CACHED_KEYS = [
  'tokens_cached',
  'cached_tokens',
  'cache_read_input_tokens',
  'cached',
];
const USAGE_CONTAINER_KEYS = ['usage', 'token_usage', 'totals', 'tokenUsage'];
const DURATION_KEYS = ['duration_s', 'duration_seconds', 'elapsed_s'];

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function pickInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = num(obj[k]);
    if (v !== null) return Math.round(v);
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface TokenCounts {
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
}

function countsFrom(obj: Record<string, unknown>): TokenCounts | null {
  const c: TokenCounts = {
    tokens_in: pickInt(obj, IN_KEYS),
    tokens_out: pickInt(obj, OUT_KEYS),
    tokens_cached: pickInt(obj, CACHED_KEYS),
  };
  if (
    c.tokens_in === null &&
    c.tokens_out === null &&
    c.tokens_cached === null
  ) {
    return null;
  }
  return c;
}

function addCounts(acc: TokenCounts, c: TokenCounts): void {
  acc.tokens_in = (acc.tokens_in ?? 0) + (c.tokens_in ?? 0);
  acc.tokens_out = (acc.tokens_out ?? 0) + (c.tokens_out ?? 0);
  acc.tokens_cached = (acc.tokens_cached ?? 0) + (c.tokens_cached ?? 0);
}

/**
 * Pull run-aggregate token counts out of an export object of unknown
 * shape: top-level usage-ish containers first, then a `messages[]` /
 * `turns[]` array each carrying a usage object.
 */
function extractCounts(root: Record<string, unknown>): TokenCounts | null {
  for (const key of USAGE_CONTAINER_KEYS) {
    const v = root[key];
    if (isObj(v)) {
      const c = countsFrom(v);
      if (c !== null) return c;
    }
  }
  // top-level flat shape
  const flat = countsFrom(root);
  if (flat !== null) return flat;

  // per-message / per-turn arrays
  for (const arrKey of ['messages', 'turns', 'calls']) {
    const arr = root[arrKey];
    if (!Array.isArray(arr)) continue;
    const acc: TokenCounts = {
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
    };
    let found = false;
    for (const item of arr) {
      if (!isObj(item)) continue;
      for (const key of USAGE_CONTAINER_KEYS) {
        const u = item[key];
        if (isObj(u)) {
          const c = countsFrom(u);
          if (c !== null) {
            addCounts(acc, c);
            found = true;
          }
        }
      }
      const direct = countsFrom(item);
      if (direct !== null) {
        addCounts(acc, direct);
        found = true;
      }
    }
    if (found) return acc;
  }
  return null;
}

function extractDurationS(root: Record<string, unknown>): number | null {
  for (const k of DURATION_KEYS) {
    const v = num(root[k]);
    if (v !== null) return v;
  }
  const start = root.started_at ?? root.created_at;
  const end = root.ended_at ?? root.finished_at ?? root.updated_at;
  if (typeof start === 'string' && typeof end === 'string') {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      return (e - s) / 1000;
    }
  }
  return null;
}

function extractModel(root: Record<string, unknown>): string | null {
  const m = root.model;
  return typeof m === 'string' && m !== '' ? m : null;
}

function estimateTokensFromFile(path: string | undefined): number {
  if (path === undefined) return 0;
  try {
    const text = readFileSync(path, 'utf8');
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

export interface ExportUsageOptions {
  /** Run id → usage.run. */
  runId: string;
  /** Ticket id → usage.ticket ('' when unknown — CollectContext gap). */
  ticket?: string;
  /** Configured model → usage.model fallback. */
  model?: string;
  /** Rendered prompt file (estimation fallback for tokens_in). */
  promptPath?: string;
  /** Run log file (estimation fallback for tokens_out). */
  logPath?: string;
}

/**
 * Parse `<run_dir>/export.json` → usage.json (SCHEMAS §13).
 * `run-aggregate` granularity, `cost_usd` null (non-token billing —
 * never synthesize dollars). Returns `source: reported` when real
 * token fields exist, `partial` when only some do, `estimated` when
 * the export is absent/unparseable/token-free.
 */
export function usageFromExport(
  exportPath: string,
  opts: ExportUsageOptions,
): Usage {
  let root: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(exportPath, 'utf8'));
    if (isObj(parsed)) root = parsed;
  } catch {
    root = null;
  }

  const model = (root !== null ? extractModel(root) : null) ?? opts.model ?? '';
  const duration_s = (root !== null ? extractDurationS(root) : null) ?? 0;
  const counts = root !== null ? extractCounts(root) : null;

  let tokens_in: number;
  let tokens_out: number;
  let tokens_cached: number;
  let source: Usage['source'];
  let notes: string | undefined;

  if (counts !== null) {
    const missing: string[] = [];
    if (counts.tokens_in === null) {
      tokens_in = estimateTokensFromFile(opts.promptPath);
      missing.push('tokens_in');
    } else {
      tokens_in = counts.tokens_in;
    }
    if (counts.tokens_out === null) {
      tokens_out = estimateTokensFromFile(opts.logPath);
      missing.push('tokens_out');
    } else {
      tokens_out = counts.tokens_out;
    }
    tokens_cached = counts.tokens_cached ?? 0;
    source = missing.length === 0 ? 'reported' : 'partial';
    if (missing.length > 0) {
      notes = `export lacked ${missing.join(', ')} — estimated from local files`;
    }
  } else {
    tokens_in = estimateTokensFromFile(opts.promptPath);
    tokens_out = estimateTokensOut(opts);
    tokens_cached = 0;
    source = 'estimated';
    notes =
      root === null
        ? 'export.json missing/unparseable — usage estimated'
        : 'export carried no token usage fields — usage estimated';
  }

  const now = new Date().toISOString();
  const usage: Usage = {
    schema: 1,
    ticket: opts.ticket ?? '',
    run: opts.runId,
    backend: 'devin',
    model,
    granularity: 'run-aggregate',
    totals: {
      tokens_in,
      tokens_out,
      tokens_cached,
      cost_usd: null,
      duration_s,
    },
    calls: [
      {
        seq: 1,
        ts: now,
        model,
        tokens_in,
        tokens_out,
        tokens_cached,
        latency_s: duration_s,
        source: source === 'reported' ? 'reported' : 'estimated',
      },
    ],
    source,
  };
  if (notes !== undefined) usage.notes = notes;
  return usage;
}

function estimateTokensOut(opts: ExportUsageOptions): number {
  return estimateTokensFromFile(opts.logPath);
}
