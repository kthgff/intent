/**
 * Extraction preservation lint (wp-143) — the cheap mechanical half of
 * the §15.9 "negations/qualifiers must survive extraction" eval gate.
 *
 * Given a source text and the atomic statements extracted from it,
 * verify that every negated or scope-qualified source sentence is
 * covered by a statement whose polarity/wording preserves the cue —
 * never a paraphrase that silently drops a "not" or an "only".
 *
 * Pure function: source + statement summaries in → violations out.
 * Violations are signals for clarification/confirmation routing, not
 * silent corrections — the conductor decides what they block.
 */
import type { LintViolation } from './coverage.js';

/** The statement shape the lint needs — a subset of the extraction
 *  output row so both raw LLM output and persisted rows can be
 *  checked. */
export interface ExtractedStatementLike {
  /** Batch key or statement_id — reported back on violations. */
  key?: string | undefined;
  /** Normalized assertion text. */
  text: string;
  /** The verbatim quote copied from the source (when present). */
  source_text?: string | null | undefined;
  polarity?: string | null | undefined;
  intent?: string | null | undefined;
}

export interface PreservationViolation extends LintViolation {
  rule: 'extraction.negation-dropped' | 'extraction.qualifier-dropped';
  /** The source sentence carrying the cue. */
  sentence: string;
  /** The cue phrase found in the source. */
  cue: string;
  /** `key` of the covering statement the violation attaches to, when
   *  the sentence is covered but the cue was dropped. */
  statement?: string;
}

/** Negation markers — "not"/"n't"/"never"/prohibition verbs. A cue in a
 *  source sentence must survive into the covering statement's polarity
 *  (`negate`), intent (`avoid`/`prohibits`), or quoted wording. */
const NEGATION_RE =
  /\b(?:not|no|never|nothing|none|nobody|nowhere|neither|nor|cannot|can't|won't|wouldn't|shouldn't|couldn't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|mustn't|must not|shall not|may not|without|avoid(?:s|ed|ing)?|prohibit(?:s|ed|ing)?|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|exclude(?:s|d|ing)?|refuse(?:s|d|ing)?|deny|denies|denied|prevent(?:s|ed|ing)?|ban(?:s|ned|ning)?)\b|\b\w+n't\b/i;

/** Scope qualifiers — bounding/limiting phrases that change when/where
 *  a claim holds. Dropping one widens a requirement silently. */
const QUALIFIER_RE =
  /\b(?:only|except(?:ing)?|unless|until|at most|at least|up to|no more than|no fewer than|fewer than|less than|more than|at minimum|at maximum|maximum|minimum|provided that|providing that|as long as|so long as|conditional on|if and only if|limited to|within|outside|between|per|each|every|any)\b/i;

/** Intents that inherently carry negation (§15.3 taxonomy). */
const NEGATING_INTENTS = new Set(['avoid', 'prohibits']);

/** Split `text` into sentences with their [start,end) source spans.
 *  Split on `.`, `!`, `?`, `;`, and newlines; spans track the offsets
 *  so statements can be matched back to the sentence they quote. */
export function sourceSentences(
  text: string,
): { sentence: string; start: number; end: number }[] {
  const out: { sentence: string; start: number; end: number }[] = [];
  const re = /[^.!?;\n]+[.!?;]*/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const idx = m.index ?? 0;
    const trimmedStart = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    out.push({
      sentence,
      start: idx + trimmedStart,
      end: idx + trimmedStart + sentence.length,
    });
  }
  return out;
}

/** Locate `quote` inside `source` (verbatim, case-sensitive) — returns
 *  the [start,end) span of the first match or null when the quote is
 *  not a verbatim substring (a paraphrase the caller must reject). */
export function locateQuote(
  source: string,
  quote: string,
): [number, number] | null {
  const i = source.indexOf(quote);
  return i === -1 ? null : [i, i + quote.length];
}

/** First regex match's matched text, or null. */
function cueOf(re: RegExp, sentence: string): string | null {
  const m = re.exec(sentence);
  return m ? m[0] : null;
}

/** Do the statement's quote/text overlap the sentence's span? Falls
 *  back to token overlap when `source_text` can't be located verbatim
 *  (the ingest pipeline rejects those anyway — the lint still reports
 *  against the best-effort match). */
function coversSentence(
  st: ExtractedStatementLike,
  source: string,
  sentence: { sentence: string; start: number; end: number },
): boolean {
  const quote = st.source_text ?? '';
  if (quote.length > 0) {
    const span = locateQuote(source, quote);
    if (span && span[0] < sentence.end && span[1] > sentence.start) {
      return true;
    }
    // Quote may cover only part of the sentence — substring either way
    // counts as coverage.
    if (
      sentence.sentence.includes(quote) ||
      quote.includes(sentence.sentence)
    ) {
      return true;
    }
  }
  const haystack = `${st.text} ${quote}`.toLowerCase();
  const tokens = sentence.sentence
    .toLowerCase()
    .split(/[^a-z0-9']+/i)
    .filter((t) => t.length > 3);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

/** Statement preserves the negation expressed in `sentence`? */
function preservesNegation(
  st: ExtractedStatementLike,
  cue: string,
): boolean {
  if (st.polarity === 'negate') return true;
  if (st.intent && NEGATING_INTENTS.has(st.intent)) return true;
  const text = `${st.text} ${st.source_text ?? ''}`.toLowerCase();
  return (
    text.includes(cue.toLowerCase()) ||
    NEGATION_RE.test(text) ||
    /\bn't\b/i.test(text)
  );
}

/** Statement preserves the qualifier expressed in `sentence`? The cue
 *  must appear in the statement's own words or its verbatim quote —
 *  polarity/intent cannot carry a scope qualifier. */
function preservesQualifier(
  st: ExtractedStatementLike,
  cue: string,
): boolean {
  const text = `${st.text}\n${st.source_text ?? ''}`.toLowerCase();
  return text.includes(cue.toLowerCase());
}

/**
 * The preservation check (§15.9 eval gate, wp-143):
 *  - every negated source sentence must be covered by a statement that
 *    preserves the negation (polarity/intent/wording);
 *  - every scope-qualified source sentence must be covered by a
 *    statement whose text/quote keeps the qualifier.
 * Uncovered cue sentences are violations too — a dropped "never" is a
 * missed requirement, not a free pass.
 */
export function extractionPreservationLint(
  source: string,
  statements: ExtractedStatementLike[],
): PreservationViolation[] {
  const violations: PreservationViolation[] = [];
  for (const s of sourceSentences(source)) {
    for (const [re, rule] of [
      [NEGATION_RE, 'extraction.negation-dropped'],
      [QUALIFIER_RE, 'extraction.qualifier-dropped'],
    ] as const) {
      const cue = cueOf(re, s.sentence);
      if (cue === null) continue;
      const covering = statements.filter((st) =>
        coversSentence(st, source, s),
      );
      const keep =
        rule === 'extraction.negation-dropped'
          ? preservesNegation
          : preservesQualifier;
      const preserved = covering.some((st) => keep(st, cue));
      if (preserved) continue;
      const kind = rule === 'extraction.negation-dropped' ? 'negation' : 'qualifier';
      const bound = covering[0]?.key;
      violations.push({
        rule,
        sentence: s.sentence,
        cue,
        ...(bound !== undefined ? { statement: bound } : {}),
        message:
          covering.length === 0
            ? `${kind} cue '${cue}' in source sentence is not covered by any extracted statement: "${s.sentence}"`
            : `${kind} cue '${cue}' dropped by extracted statement(s) covering: "${s.sentence}"`,
      });
    }
  }
  return violations;
}
