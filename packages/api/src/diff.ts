/**
 * Minimal unified-ish line diff for doc_versions (API.md S-06:
 * "rendered … + version diffs"). LCS-based — emits `-`/`+` runs
 * bracketed by `@@` hunk markers; enough for the UI's DiffView to
 * render adds/dels. Not a full Myers implementation — docs are small
 * and this is a display aid, not a merge tool.
 */
export function lineDiff(from: string, to: string): string {
  const a = from.split('\n');
  const b = to.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS table (docs are ≤ a few hundred lines — O(n·m) is fine).
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = dp.at(i);
    const below = dp.at(i + 1);
    if (!row || !below) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (below.at(j + 1) ?? 0) + 1
          : Math.max(below.at(j) ?? 0, row.at(j + 1) ?? 0);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  let inHunk = false;
  const hunk = () => {
    if (!inHunk) {
      out.push('@@');
      inHunk = true;
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (inHunk) {
        out.push(` ${a[i]}`);
      }
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      hunk();
      out.push(`-${a[i]}`);
      i++;
    } else {
      hunk();
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    hunk();
    out.push(`-${a[i]}`);
    i++;
  }
  while (j < m) {
    hunk();
    out.push(`+${b[j]}`);
    j++;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Unified-diff apply — chat-to-edit (s-01 D25, API.md interview edit mode).
// The model emits `proposed-diff.md`; approve applies it to the CURRENT
// doc. Both halves fail closed: a diff that doesn't parse or whose
// context lines don't match the doc throws DiffApplyError, never a
// best-effort merge (AGENTS.md — malformed structured output blocks).
// ---------------------------------------------------------------------------

export class DiffApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffApplyError';
  }
}

interface HunkLine {
  op: ' ' | '-' | '+';
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface ParsedUnifiedDiff {
  /** Path from the `---` header (a/ prefix stripped). */
  from: string;
  /** Path from the `+++` header (b/ prefix stripped). */
  to: string;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const stripPrefix = (p: string) => p.replace(/^[ab]\//, '');

/**
 * Parse ONE unified-diff file entry. Accepts the `diff --git` preamble
 * and `index`/`new file`-style lines are NOT tolerated — this is a
 * content patch format only (no binary/mode/rename hunks). Throws
 * DiffApplyError on anything unexpected.
 */
export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // Skip leading `diff --git …` preamble lines.
  while (i < lines.length && lines[i]?.startsWith('diff --git ')) i++;
  // Optional index/mode preamble (reject rename/binary outright below).
  let from: string | undefined;
  while (i < lines.length) {
    const l = lines[i] ?? '';
    if (l.startsWith('--- ')) {
      from = stripPrefix(l.slice(4).trim());
      i++;
      break;
    }
    if (l === '' || l.startsWith('index ') || l.startsWith('Index:')) {
      i++;
      continue;
    }
    throw new DiffApplyError(`unexpected diff preamble line: '${l}'`);
  }
  if (from === undefined) throw new DiffApplyError('missing --- header');
  if (i >= lines.length || !lines[i]?.startsWith('+++ ')) {
    throw new DiffApplyError('missing +++ header');
  }
  const to = stripPrefix((lines[i] ?? '').slice(4).trim());
  i++;

  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const l = lines[i] ?? '';
    if (l === '') {
      i++;
      continue; // tolerate blank separators between hunks
    }
    if (l.startsWith('diff --git ')) {
      throw new DiffApplyError(
        'multi-file diffs are not supported — one file entry only',
      );
    }
    const m = HUNK_RE.exec(l);
    if (!m) throw new DiffApplyError(`malformed hunk header: '${l}'`);
    const hunk: Hunk = {
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
      lines: [],
    };
    i++;
    let oldSeen = 0;
    let newSeen = 0;
    while (i < lines.length) {
      const hl = lines[i] ?? '';
      if (hl.startsWith('\\')) {
        // "\ No newline at end of file" — metadata, skip.
        i++;
        continue;
      }
      const op = hl[0];
      if (op === ' ' || op === '-' || op === '+') {
        hunk.lines.push({ op, text: hl.slice(1) });
        if (op !== '+') oldSeen++;
        if (op !== '-') newSeen++;
        i++;
        continue;
      }
      break; // next hunk header / EOF
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      throw new DiffApplyError(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} ` +
          `declares ${hunk.oldCount}/${hunk.newCount} lines, carries ${oldSeen}/${newSeen}`,
      );
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new DiffApplyError('diff contains no hunks');
  return { from, to, hunks };
}

/**
 * Apply a parsed unified diff to `original` with STRICT context
 * matching — every ' '/ '-' line must equal the doc's line at the
 * expected position (offset-adjusted across hunks). A mismatch means
 * the doc drifted since the diff was computed → throw (the human
 * re-requests the edit); we never fuzzy-apply.
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const parsed = parseUnifiedDiff(diff);
  const src = original.split('\n');
  const out: string[] = [];
  let cursor = 0; // 0-based index into src
  for (const hunk of parsed.hunks) {
    const start = hunk.oldStart - 1; // hunks are 1-based
    if (start < cursor) {
      throw new DiffApplyError(
        `hunk @@ -${hunk.oldStart} overlaps the previous hunk`,
      );
    }
    // Copy untouched lines before this hunk.
    while (cursor < start) {
      const line = src[cursor];
      if (line === undefined) {
        throw new DiffApplyError(
          `hunk @@ -${hunk.oldStart} starts past end of doc`,
        );
      }
      out.push(line);
      cursor++;
    }
    for (const l of hunk.lines) {
      if (l.op === '+') {
        out.push(l.text);
        continue;
      }
      const actual = src[cursor];
      if (actual === undefined || actual !== l.text) {
        throw new DiffApplyError(
          `context mismatch at doc line ${cursor + 1}: expected '${l.text}', found '${actual ?? '<eof>'}' — the doc has drifted since this diff was proposed`,
        );
      }
      if (l.op === '-')
        cursor++; // consumed, not emitted
      else {
        out.push(actual);
        cursor++;
      }
    }
  }
  while (cursor < src.length) {
    out.push(src[cursor] ?? '');
    cursor++;
  }
  return out.join('\n');
}

/**
 * Pull the unified diff out of a `proposed-diff.md` artifact: a
 * ```diff fenced block when present, else the contiguous diff tail
 * starting at the first `diff --git` / `--- ` / `@@` line. Throws
 * DiffApplyError when no diff is found.
 */
export function extractUnifiedDiff(md: string): string {
  const fenced = /```(?:diff|patch)?[^\S\n]*\n([\s\S]*?)```/.exec(md);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (/^(diff --git |--- |@@ )/m.test(body)) return `${body}\n`;
  }
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^(diff --git |--- |@@ )/.test(l));
  if (start === -1) {
    throw new DiffApplyError('no unified diff found in proposed-diff.md');
  }
  return `${lines.slice(start).join('\n').trim()}\n`;
}
