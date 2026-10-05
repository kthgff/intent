/**
 * interview/prompt.ts — the orchestrator's LLM-assist prompt surface
 * (PRD §15.9 "deterministic orchestration / LLM assist split").
 *
 * Only two things are delegated to a model:
 *  1. interpreting an answer → statements (wp-143's `runExtraction`,
 *     `EXTRACT_PROMPT_VERSION` — this module does not re-implement it);
 *  2. proposing the next question (this module's planner prompt).
 *
 * The planner prompt is *code*, not a core template: versioning rides
 * {@link INTERVIEW_PROMPT_VERSION}. The model proposes a question +
 * component scores; the runner owns eligibility and the final
 * composite (`scoreCandidate`) — the model never picks the slot.
 */
import { z } from 'zod';
import { invalid } from './types.js';

/** Stamped on every planner proposal produced through this builder. */
export const INTERVIEW_PROMPT_VERSION = 'interview-v1';

/** One scored question proposal — the planner's structured output. */
export const QuestionOutputSchema = z.object({
  schema: z.literal(1),
  slot: z.string().min(1),
  question: z.string().min(1),
  why: z.string().optional(),
  format: z.string().optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        recommended: z.boolean().optional(),
      }),
    )
    .optional(),
  scores: z.object({
    impact: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    answerability: z.number().min(0).max(1),
    effort: z.number().min(0).max(1),
  }),
});
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;

/** Parse + schema-validate a planner proposal (fail-closed). */
export function parseQuestionOutput(output: unknown): QuestionOutput {
  let raw = output;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw invalid(
        `planner output is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  const parsed = QuestionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      `planner output fails the question schema: ${parsed.error.message}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export interface EligibleSlotForPrompt {
  slot: string;
  label?: string | undefined;
  purpose: 'fill' | 'confirm';
  state: string;
  /** Known value when confirming. */
  value?: string | null | undefined;
  /** Deterministic fallback question (the model may improve on it). */
  suggested?: string | undefined;
}

export interface BuildQuestionPromptArgs {
  wizardId: string;
  subject?: string | null | undefined;
  /** Free-form planner override from the wizard definition. */
  override?: string | undefined;
  eligible: EligibleSlotForPrompt[];
  /** Already-asked questions (never re-ask). */
  asked?:
    | { slot: string | null; question: string; status: string }[]
    | undefined;
  /** Live statements the model may reference for context. */
  knownStatements?: { id: string; text: string }[] | undefined;
}

/**
 * Render the deterministic planner prompt. The contract it teaches is
 * {@link QuestionOutputSchema}: pick ONE eligible slot, ask the single
 * question that most changes the outcome, and estimate the component
 * scores honestly (answerability 0 when the user can't answer — the
 * runner will record `unanswerable` and never re-ask).
 */
export function buildQuestionPrompt(args: BuildQuestionPromptArgs): string {
  const slots = args.eligible
    .map((s) => {
      const bits = [`- ${s.slot} [${s.purpose}] (state: ${s.state})`];
      if (s.label) bits.push(`  label: ${s.label}`);
      if (s.value) bits.push(`  known: ${s.value}`);
      if (s.suggested) bits.push(`  suggested question: ${s.suggested}`);
      return bits.join('\n');
    })
    .join('\n');
  const asked = args.asked ?? [];
  const askedBlock =
    asked.length === 0
      ? ''
      : `\n## Already asked (NEVER re-ask)\n${asked
          .map(
            (a) => `- [${a.status}] ${a.slot ?? '(unscoped)'}: ${a.question}`,
          )
          .join('\n')}`;
  const known = args.knownStatements ?? [];
  const knownBlock =
    known.length === 0
      ? ''
      : `\n## Known statements\n${known
          .map((k) => `- ${k.id}: ${k.text}`)
          .join('\n')}`;

  const header = args.override
    ? args.override
    : `You are the QUESTION PLANNER for the Veto interview orchestrator (PRD §15.9).
Assemble what is already known, identify the gaps, and ask ONLY what
materially changes the outcome. "The best question is the one the
wizard realizes it doesn't need."`;

  return `${header}

Wizard: ${args.wizardId}${args.subject ? ` (subject: ${args.subject})` : ''}

## Output — JSON only, no prose, no fences

{
  "schema": 1,
  "slot": "<one of the eligible slots below>",
  "question": "<the single best next question>",
  "why": "<what this materially changes>",
  "format": "free-text|single-choice|multi-choice|number",
  "options": [{"label": "<choice>", "recommended": true}],
  "scores": {
    "impact": 0.0,        // how much the answer changes the outcome
    "uncertainty": 0.0,   // how much we don't yet know
    "relevance": 0.0,     // centrality to the required areas
    "answerability": 0.0, // can the user answer? 0 = they can't
    "effort": 0.0         // cost to the user; 0 = cheap
  }
}

## Rules

1. Pick exactly ONE slot from the eligible list — do not invent slots.
2. Ask the question with the highest impact × uncertainty × relevance
   that the user can actually answer at low effort. Prefer fewer,
   sharper questions.
3. NEVER re-ask a question already asked. If the user cannot answer,
   set "answerability": 0 — the runner records it unresolved and never
   asks again.
4. Scores are estimates in [0,1]; the runner recomputes the composite
   deterministically.
${askedBlock}${knownBlock}
## Eligible slots

${slots}
`;
}
