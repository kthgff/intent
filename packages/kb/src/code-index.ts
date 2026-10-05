/**
 * Commit-pinned code index (INTELLIGENCE §4.1, D37, wp-110).
 *
 * Indexes a repository checkout at an authorized commit SHA into
 * `code_units` at symbol/logical-unit boundaries, with bounded fallback
 * chunks for unsupported or syntactically broken files, plus structural
 * `code_edges` (definitions, imports, test links) and optional
 * content-addressed embeddings.
 *
 * Invariants:
 * - The head is created `building`, written, then promoted `current`
 *   atomically (store.promoteRepoIndexHead). `building`/`failed` heads
 *   are never served as current (DB-SCHEMA D37). On any error the head
 *   flips to `failed` — a partial index never becomes current.
 * - Unchanged content is reused by hash: files whose content hash
 *   matches the previous head are copied without re-parsing, and
 *   embeddings are content-addressed so unchanged units never re-embed.
 * - Historical units stay addressable — superseded heads and their rows
 *   are retained for citations/audit.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  CodeEdgeRow,
  CodeHead,
  CodeParseStatus,
  CodeUnitRow,
  EvidenceFreshness,
  RepoIndexRow,
  Store,
} from '@sprint-runner/core';
import type { Embedder } from './embeddings.js';

/** Parser identity stamped on each index head. */
export const CODE_INDEX_PARSER_VERSION = 'wp-110/1';

/** Bounded fallback chunk size (lines) + overlap between chunks. */
export const FALLBACK_CHUNK_LINES = 60;
export const FALLBACK_OVERLAP_LINES = 8;
/** Hard cap on units extracted per file (bounded work). */
export const MAX_UNITS_PER_FILE = 400;
/** Files larger than this are skipped (binary/generated/oversized). */
export const MAX_FILE_BYTES = 512 * 1024;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.cache',
]);

const IGNORED_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.env(\..*)?|.*\.min\.(js|css)|.*\.(png|jpe?g|gif|svg|ico|pdf|zip|gz|tgz|tar|bz2|woff2?|ttf|eot|mp4|mov|mp3|wasm|snap|so|dylib|dll|exe|bin|class|jar|o|a))$/i;

/** Language by file extension — unsupported extensions fall back to
 *  bounded line chunks. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
};

interface SymbolPattern {
  re: RegExp;
  kind: string;
}

const TS_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
  },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/,
    kind: 'function',
  },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' },
];

const PY_PATTERNS: SymbolPattern[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
];

const GO_PATTERNS: SymbolPattern[] = [
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^\s*(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'var' },
];

const RS_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/,
    kind: 'type',
  },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl' },
];

const RB_PATTERNS: SymbolPattern[] = [
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'function' },
  { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: 'class' },
];

const JVM_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*(?:public|private|protected|internal|static|final|abstract|open|override|sealed|data|partial|\s)*\b(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/,
    kind: 'type',
  },
  {
    re: /^\s*(?:public|private|protected|internal|open|override|suspend|inline|tailrec|operator|infix|async|\s)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
    kind: 'function',
  },
];

const PHP_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*(?:public|private|protected|static|abstract|final|\s)*function\s+([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
    kind: 'type',
  },
];

const SWIFT_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*(?:public|private|internal|fileprivate|open|static|class|override|mutating|\s)*func\s+([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:public|private|internal|final|open|\s)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/,
    kind: 'type',
  },
];

const SCALA_PATTERNS: SymbolPattern[] = [
  { re: /^\s*(?:private|protected|override|implicit|\s)*def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*(?:case\s+)?(?:class|object|trait)\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^\s*(?:val|var)\s+([A-Za-z_]\w*)/, kind: 'val' },
];

const SHELL_PATTERNS: SymbolPattern[] = [
  { re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, kind: 'function' },
];

const SQL_PATTERNS: SymbolPattern[] = [
  {
    re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z_."]+)/i,
    kind: 'function',
  },
  {
    re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_."]+)/i,
    kind: 'type',
  },
];

const RESERVED = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'else',
  'do',
  'try',
  'with',
  'new',
  'delete',
  'typeof',
  'await',
  'yield',
  'function',
  'class',
  'const',
  'let',
  'var',
]);

function patternsFor(language: string): SymbolPattern[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return TS_PATTERNS;
    case 'python':
      return PY_PATTERNS;
    case 'go':
      return GO_PATTERNS;
    case 'rust':
      return RS_PATTERNS;
    case 'ruby':
      return RB_PATTERNS;
    case 'java':
    case 'kotlin':
    case 'csharp':
    case 'c':
    case 'cpp':
      return JVM_PATTERNS;
    case 'php':
      return PHP_PATTERNS;
    case 'swift':
      return SWIFT_PATTERNS;
    case 'scala':
      return SCALA_PATTERNS;
    case 'shell':
      return SHELL_PATTERNS;
    case 'sql':
      return SQL_PATTERNS;
    default:
      return [];
  }
}

/** sha256 of a string, prefixed for readability. */
export function hashContent(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Stable, content-locator unit id — deterministic over the coordinate
 * (workspace, repo, commit, path, line range), so re-indexing the same
 * commit is idempotent and a superseded unit stays addressable.
 */
export function codeUnitId(key: {
  workspace: string;
  repo: string;
  commit_sha: string;
  path: string;
  start_line: number;
  end_line: number;
}): string {
  const h = createHash('sha256')
    .update(
      [
        key.workspace,
        key.repo,
        key.commit_sha,
        key.path,
        String(key.start_line),
        String(key.end_line),
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 32);
  return `cu_${h}`;
}

/** Content-addressed embedding object_ref — unchanged content across
 *  commits reuses one embedding row (INTELLIGENCE §4.1 step 5). */
export function codeContentRef(contentHash: string): string {
  return `codecontent:${contentHash}`;
}

export interface SymbolSpan {
  name: string;
  kind: string;
  start: number;
  end: number;
}

/** Extract symbol/logical-unit spans from source lines (heuristic,
 *  language-aware; tree-sitter is the preferred later enrichment). */
export function extractSymbols(lines: string[], language: string): SymbolSpan[] {
  const patterns = patternsFor(language);
  if (patterns.length === 0) return [];
  const starts: { name: string; kind: string; start: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const p of patterns) {
      const m = p.re.exec(line);
      const name = m?.[1];
      if (name && !RESERVED.has(name)) {
        starts.push({ name, kind: p.kind, start: i + 1 });
        break;
      }
    }
    if (starts.length >= MAX_UNITS_PER_FILE) break;
  }
  return starts.map((s, idx) => ({
    name: s.name,
    kind: s.kind,
    start: s.start,
    end: idx + 1 < starts.length ? (starts[idx + 1]?.start ?? s.start) - 1 : lines.length,
  }));
}

/** Bounded, overlapping line chunks for unsupported/broken files. */
export function fallbackChunks(
  lines: string[],
): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  const step = Math.max(1, FALLBACK_CHUNK_LINES - FALLBACK_OVERLAP_LINES);
  for (let start = 1; start <= lines.length; start += step) {
    const end = Math.min(lines.length, start + FALLBACK_CHUNK_LINES - 1);
    chunks.push({ start, end });
    if (end >= lines.length) break;
    if (chunks.length >= MAX_UNITS_PER_FILE) break;
  }
  return chunks;
}

/** A code unit before it is pinned to a commit. */
export interface UnitDraft {
  path: string;
  language: string;
  symbol: string | null;
  symbol_kind: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  parse_status: CodeParseStatus;
}

/** Extract the units for one file's content. */
export function extractUnits(
  path: string,
  language: string | null,
  content: string,
): UnitDraft[] {
  const lines = content.split('\n');
  const lang = language ?? 'text';
  const units: UnitDraft[] = [];
  const push = (
    start: number,
    end: number,
    symbol: string | null,
    symbolKind: string | null,
    parseStatus: CodeParseStatus,
  ): void => {
    const slice = lines.slice(start - 1, end).join('\n');
    units.push({
      path,
      language: lang,
      symbol,
      symbol_kind: symbolKind,
      start_line: start,
      end_line: end,
      content: slice,
      content_hash: hashContent(slice),
      parse_status: parseStatus,
    });
  };

  const spans = language ? extractSymbols(lines, language) : [];
  if (spans.length === 0) {
    // Unsupported language OR a file with no recognizable symbols —
    // bounded fallback chunks, never silently dropped.
    for (const c of fallbackChunks(lines)) {
      push(c.start, c.end, null, null, 'fallback');
    }
    return units;
  }

  // Module header (imports/top-level) before the first symbol is a
  // logical unit too — captured so import edges have a home.
  const first = spans[0];
  if (first && first.start > 1) {
    const headerEnd = first.start - 1;
    const headerText = lines.slice(0, headerEnd).join('\n');
    if (headerText.trim().length > 0) {
      push(1, headerEnd, null, 'module', 'parsed');
    }
  }
  for (const s of spans) {
    push(s.start, s.end, s.name, s.kind, 'parsed');
  }
  return units;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

export interface CheckoutFile {
  /** POSIX-relative path from the checkout root. */
  path: string;
  content: string;
  fileHash: string;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Walk a checkout applying the ignore policy (INTELLIGENCE §4.1 step 2).
 *  Returns text files only; binary/oversized/ignored paths are skipped. */
export function readCheckout(
  checkoutDir: string,
  forbiddenPaths: string[] = [],
): CheckoutFile[] {
  const out: CheckoutFile[] = [];
  const forbidden = forbiddenPaths.map((p) => p.replace(/^\.?\//, ''));
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = toPosix(relative(checkoutDir, abs));
      if (IGNORED_DIRS.has(entry)) continue;
      if (IGNORED_FILE.test(rel)) continue;
      if (forbidden.some((f) => rel === f || rel.startsWith(`${f}/`))) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      out.push({
        path: rel,
        content: buf.toString('utf8'),
        fileHash: hashContent(buf.toString('utf8')),
      });
    }
  };
  walk(checkoutDir);
  return out;
}

// ---------------------------------------------------------------------------
// Import + edge extraction
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gm,
  /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
  /^\s*use\s+([A-Za-z_][\w:]+)/gm,
  /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
  /^\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

/** Extract import specifiers from file content (best-effort, bounded). */
export function extractImports(content: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    for (const m of content.matchAll(re)) {
      const spec = m[1] ?? m[2];
      if (spec) found.add(spec);
      if (found.size >= 200) return [...found];
    }
  }
  return [...found];
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[A-Za-z]+$/i;

function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** An explicit workflow link to persist with the index (source
 *  `explicit`, verification `verified` by construction). */
export interface ExplicitCodeLink {
  subject_ref: string;
  predicate: CodeEdgeRow['predicate'];
  object_ref: string;
  evidence?: string;
}

/** A structural edge before it is pinned to a commit. */
export interface StructuralEdge {
  subject_ref: string;
  predicate: CodeEdgeRow['predicate'];
  object_ref: string;
  evidence: string | null;
  source: string;
}

/** Build structural edges for one file's units. */
export function structuralEdges(
  path: string,
  units: UnitDraft[],
  content: string,
): StructuralEdge[] {
  const edges: StructuralEdge[] = [];
  const fileRef = `file:${path}`;
  for (const u of units) {
    if (u.symbol) {
      edges.push({
        subject_ref: fileRef,
        predicate: 'defines',
        object_ref: `symbol:${path}:${u.symbol}`,
        evidence: `${path}:${u.start_line}`,
        source: 'parser',
      });
    }
  }
  for (const spec of extractImports(content)) {
    edges.push({
      subject_ref: fileRef,
      predicate: 'imports',
      object_ref: `module:${spec}`,
      evidence: `${path}:1`,
      source: 'parser',
    });
    if (isTestPath(path)) {
      edges.push({
        subject_ref: fileRef,
        predicate: 'tests',
        object_ref: `module:${spec}`,
        evidence: `${path}:1`,
        source: 'parser',
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Index pipeline
// ---------------------------------------------------------------------------

export interface IndexStats {
  files: number;
  units: number;
  fallbacks: number;
  reused_files: number;
  reused_units: number;
  edges: number;
  embedded: number;
  /** path → file content hash, used for incremental reuse. */
  path_hashes: Record<string, string>;
}

export interface IndexRepoOptions {
  workspace: string;
  repo: string;
  /** Authorized local checkout root. */
  checkoutDir: string;
  commitSha: string;
  parserVersion?: string;
  /** Extra exclusions beyond the default ignore policy. */
  forbiddenPaths?: string[];
  /** Live embedder; null/off skips embedding writes. */
  embedder?: Embedder | null;
  /** Explicit workflow links persisted with the index. */
  explicitLinks?: ExplicitCodeLink[];
  /** Live-channel hook (`index_status`), best-effort. */
  notify?: (event: { type: 'index_status'; payload: unknown }) => void;
  now?: () => string;
}

export interface IndexRepoResult {
  repoIndex: RepoIndexRow;
  stats: IndexStats;
}

async function previousPathHashes(
  store: Store,
  workspace: string,
  repo: string,
): Promise<{ commitSha: string | null; pathHashes: Record<string, string> }> {
  const current = await store.getCurrentRepoIndex(workspace, repo);
  const heads = current
    ? [current]
    : (await store.listRepoIndexes({ workspace, repo, status: 'superseded' })).slice(
        0,
        1,
      );
  const head = heads[0];
  if (!head) return { commitSha: null, pathHashes: {} };
  const hashes = head.stats?.path_hashes;
  return {
    commitSha: head.commit_sha,
    pathHashes:
      hashes && typeof hashes === 'object'
        ? (hashes as Record<string, string>)
        : {},
  };
}

async function embedUnits(
  store: Store,
  embedder: Embedder,
  units: UnitDraft[],
): Promise<number> {
  let embedded = 0;
  const seen = new Set<string>();
  for (const u of units) {
    const ref = codeContentRef(u.content_hash);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const existing = await store.getEmbedding({
      object_ref: ref,
      model: embedder.model,
    });
    if (existing) continue;
    const vec = await embedder.embed(
      [u.symbol ?? '', u.path, u.content].filter((s) => s.length > 0).join('\n'),
    );
    if (vec === null || vec.length === 0) continue;
    await store.upsertEmbedding({
      object_ref: ref,
      model: embedder.model,
      vector: Array.from(vec),
    });
    embedded += 1;
  }
  return embedded;
}

/**
 * Index one repository checkout at `commitSha`. Creates a `building`
 * head, writes units/edges/embeddings, then promotes the head to
 * `current` atomically. Any failure flips the head to `failed` (never
 * served) and rethrows — a partial index never becomes current.
 */
export async function indexRepo(
  store: Store,
  opts: IndexRepoOptions,
): Promise<IndexRepoResult> {
  const nowIso = opts.now ?? (() => new Date().toISOString());
  const parserVersion = opts.parserVersion ?? CODE_INDEX_PARSER_VERSION;
  const key = {
    workspace: opts.workspace,
    repo: opts.repo,
    commit_sha: opts.commitSha,
  };

  // Previous head (current, else most recent superseded) — for reuse.
  const prev = await previousPathHashes(store, opts.workspace, opts.repo);

  await store.upsertRepoIndex({
    workspace: opts.workspace,
    repo: opts.repo,
    commit_sha: opts.commitSha,
    status: 'building',
    parser_version: parserVersion,
    indexed_at: null,
    stats: null,
  });

  try {
    const files = readCheckout(opts.checkoutDir, opts.forbiddenPaths ?? []);
    const stats: IndexStats = {
      files: 0,
      units: 0,
      fallbacks: 0,
      reused_files: 0,
      reused_units: 0,
      edges: 0,
      embedded: 0,
      path_hashes: {},
    };
    const allUnits: CodeUnitRow[] = [];
    const pendingDrafts: UnitDraft[] = [];
    const allEdges: CodeEdgeRow[] = [];

    const toRow = (d: UnitDraft): CodeUnitRow => ({
      id: codeUnitId({
        workspace: opts.workspace,
        repo: opts.repo,
        commit_sha: opts.commitSha,
        path: d.path,
        start_line: d.start_line,
        end_line: d.end_line,
      }),
      workspace: opts.workspace,
      repo: opts.repo,
      commit_sha: opts.commitSha,
      path: d.path,
      language: d.language,
      symbol: d.symbol,
      symbol_kind: d.symbol_kind,
      start_line: d.start_line,
      end_line: d.end_line,
      content_hash: d.content_hash,
      content: d.content,
      parse_status: d.parse_status,
    });

    for (const file of files) {
      stats.files += 1;
      stats.path_hashes[file.path] = file.fileHash;

      const reused =
        prev.commitSha !== null &&
        prev.pathHashes[file.path] !== undefined &&
        prev.pathHashes[file.path] === file.fileHash;

      if (reused) {
        // Copy the previous head's units for this path — no re-parse.
        const prior = await store.listCodeUnits({
          workspace: opts.workspace,
          repo: opts.repo,
          commit_sha: prev.commitSha as string,
          path: file.path,
        });
        for (const p of prior) {
          allUnits.push({
            ...p,
            commit_sha: opts.commitSha,
            id: codeUnitId({
              workspace: opts.workspace,
              repo: opts.repo,
              commit_sha: opts.commitSha,
              path: p.path,
              start_line: p.start_line,
              end_line: p.end_line,
            }),
          });
          if (p.parse_status === 'fallback') stats.fallbacks += 1;
        }
        stats.reused_files += 1;
        stats.reused_units += prior.length;
        stats.units += prior.length;
        continue;
      }

      const ext = file.path.slice(file.path.lastIndexOf('.'));
      const language = LANGUAGES[ext.toLowerCase()] ?? null;
      const unitDrafts = extractUnits(file.path, language, file.content);
      const drafts = unitDrafts.map(toRow);
      for (const d of unitDrafts) {
        if (d.parse_status === 'fallback') stats.fallbacks += 1;
        pendingDrafts.push(d);
      }
      allUnits.push(...drafts);
      stats.units += drafts.length;
      for (const e of structuralEdges(file.path, unitDrafts, file.content)) {
        allEdges.push({
          workspace: opts.workspace,
          repo: opts.repo,
          commit_sha: opts.commitSha,
          subject_ref: e.subject_ref,
          predicate: e.predicate,
          object_ref: e.object_ref,
          evidence: e.evidence,
          source: e.source,
          confidence: 1,
        });
      }
    }

    for (const link of opts.explicitLinks ?? []) {
      allEdges.push({
        workspace: opts.workspace,
        repo: opts.repo,
        commit_sha: opts.commitSha,
        subject_ref: link.subject_ref,
        predicate: link.predicate,
        object_ref: link.object_ref,
        evidence: link.evidence ?? null,
        source: 'explicit',
        confidence: null,
      });
    }
    stats.edges = allEdges.length;

    // Write units + edges for the new commit.
    await store.upsertCodeUnits(allUnits);
    for (const e of allEdges) await store.upsertCodeEdge(e);

    // Embeddings — content-addressed, so unchanged units reuse rows.
    if (opts.embedder) {
      stats.embedded = await embedUnits(store, opts.embedder, pendingDrafts);
    }

    // Promote atomically — only now is this head servable.
    await store.setRepoIndexStatus(key, 'building', {
      stats: stats as unknown as Record<string, unknown>,
    });
    await store.promoteRepoIndexHead(key, nowIso());

    const repoIndex: RepoIndexRow = {
      workspace: opts.workspace,
      repo: opts.repo,
      commit_sha: opts.commitSha,
      status: 'current',
      parser_version: parserVersion,
      indexed_at: nowIso(),
      stats: stats as unknown as Record<string, unknown>,
    };
    opts.notify?.({ type: 'index_status', payload: repoIndex });
    return { repoIndex, stats };
  } catch (err) {
    await store
      .setRepoIndexStatus(key, 'failed', { indexed_at: nowIso() })
      .catch(() => {});
    opts.notify?.({
      type: 'index_status',
      payload: { ...key, status: 'failed' },
    });
    throw err;
  }
}

/**
 * Resolve the retrieval heads for authorized repos (INTELLIGENCE §4.2).
 * `current` policy → only `status = current` heads. `allow-stale` →
 * the current head, else the most recent `superseded` head (labeled
 * `stale`). A repo with no eligible head contributes nothing.
 */
export async function resolveCodeHeads(
  store: Store,
  opts: {
    workspace: string;
    repos: string[];
    commitPolicy: 'current' | 'allow-stale';
  },
): Promise<(CodeHead & { freshness: EvidenceFreshness })[]> {
  const heads: (CodeHead & { freshness: EvidenceFreshness })[] = [];
  for (const repo of opts.repos) {
    const current = await store.getCurrentRepoIndex(opts.workspace, repo);
    if (current) {
      heads.push({
        repo,
        commit_sha: current.commit_sha,
        freshness: 'current',
      });
      continue;
    }
    if (opts.commitPolicy === 'allow-stale') {
      const superseded = await store.listRepoIndexes({
        workspace: opts.workspace,
        repo,
        status: 'superseded',
      });
      const head = superseded[0];
      if (head) {
        heads.push({
          repo,
          commit_sha: head.commit_sha,
          freshness: 'stale',
        });
      }
    }
  }
  return heads;
}
