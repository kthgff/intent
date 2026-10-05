/**
 * Extraction prompt builder (wp-143) — the deterministic prompt text
 * handed to whatever LLM surface the caller injects into
 * {@link runExtraction} (agent stage, interview LLM assist, import
 * pass). The prompt is code, not a core template: extraction prompt
 * versioning rides `semantic_extraction_runs.prompt_version` =
 * {@link EXTRACT_PROMPT_VERSION}.
 *
 * The contract it teaches is `ExtractionOutputSchema` (SCHEMAS §22):
 * atomic statements, verbatim `source_text` + `span`, typed relations,
 * clarifications for ambiguity — and negations/qualifiers MUST survive
 * (the preservation lint checks).
 */
import type { ExtractionSource } from './types.js';

/** Stamped on every extraction run produced through this builder. */
export const EXTRACT_PROMPT_VERSION = 'extract-v1';

export interface BuildExtractionPromptArgs {
  sources: ExtractionSource[];
  /** Existing ledger statements the batch may relate to (dedupe,
   *  contradicts, supersedes targets) — `{id, text, status}`. */
  knownStatements?: { id: string; text: string; status?: string }[];
}

/** Render the extraction prompt for a batch of evidence sources. */
export function buildExtractionPrompt(args: BuildExtractionPromptArgs): string {
  const known = args.knownStatements ?? [];
  const sourceBlocks = args.sources
    .map(
      (s, i) =>
        `### Source ${i} — ${s.ref.kind}:${s.ref.id}\n\`\`\`\n${s.text}\n\`\`\``,
    )
    .join('\n\n');
  const knownBlock =
    known.length === 0
      ? ''
      : `\n\n## Existing statements (relation targets — use their ids verbatim)\n${known
          .map((k) => `- ${k.id}${k.status ? ` [${k.status}]` : ''}: ${k.text}`)
          .join('\n')}`;

  return `You are a STATEMENT EXTRACTOR for the Veto statement ledger (PRD §15.3).

Turn each source into ATOMIC semantic statements — one assertion per
statement; one source may yield many. The source is evidence; the
statements are its meaning.

## Output — JSON only, no prose, no fences

{
  "schema": 1,
  "statements": [
    {
      "key": "s1",                    // unique within this batch
      "text": "<the atomic assertion, normalized wording>",
      "source": 0,                    // index into the sources below
      "source_text": "<VERBATIM substring of that source>",
      "span": [start, end],           // char offsets, optional — located
                                      // verbatim when omitted
      "intent": "want|avoid|prohibits|requires|constraint|assumption|decision|question|problem|observation",
      "polarity": "affirm|negate",    // negate when the claim is a NOT
      "subject": "<topic>",           // optional
      "strength": "must|should|nice|undecided",
      "scope": "org|solution|initiative|feature|repo|ticket|board",
      "scope_ref": "<entity id>",     // optional
      "confidence": 0.0,              // optional
      "relations": [
        {"predicate": "supports|contradicts|clarifies|duplicates|depends-on|supersedes|derived-from",
         "target": "<batch key or existing statement id>"}
      ],
      "clarification": "<question>"   // ambiguity you cannot resolve —
                                      // never guess
    }
  ]
}

## Rules

1. "source_text" MUST be a verbatim substring — never paraphrase,
   summarize, or repair the quote. Spans are verified by the runner;
   a non-verbatim quote fails the whole batch.
2. NEGATIONS AND QUALIFIERS MUST SURVIVE. "never X", "only on Y",
   "unless Z" change the claim's meaning — encode negation in
   "polarity": "negate" (and/or intent "avoid"/"prohibits") and keep
   the qualifier words in "text".
3. Prefer fewer, sharper statements over exhaustive coverage — but
   never drop a negated or qualified claim.
4. Relations point FROM the statement TO its target — use a batch
   "key" for new statements or an existing statement id below.
5. Do not declare truth status — every extracted statement lands
   "proposed"; consequential ones (prohibits/requires/constraint/
   decision/must) get routed for human confirmation automatically.
${knownBlock}
## Sources

${sourceBlocks}
`;
}
