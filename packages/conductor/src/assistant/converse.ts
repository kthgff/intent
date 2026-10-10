/**
 * assistant/converse.ts — the freeform command-mode turn (TDD turn
 * pipeline step 3). Board digest + recent turns → provider →
 * `ConverseOutputSchema` — fail-closed: malformed output yields zero
 * ops and a reply that says so; missing provider yields a reply that
 * says a model is required (R10 fail-loud).
 */
import type {
  BoardConnector,
  BoardItem,
  ConverseMessage,
  InterviewMessageRow,
  ProposalOp,
} from '@veto/core';
import { ConverseOutputSchema } from '@veto/core';
import { z } from 'zod';
import { transcript } from '../interview/index.js';
import { type CritiqueFinding, boardCoverage } from './coverage.js';
import type { AssistantCtx } from './types.js';

/** Deterministic reply when no provider is configured. */
export const NO_PROVIDER_REPLY =
  'No model is configured for the assistant — freeform commands need one. ' +
  '/interview, /expand and /critique still work.';

/** The fail-closed reply when the model's output won't validate. */
export const MALFORMED_REPLY =
  "I couldn't shape that answer into board actions — nothing was proposed.";

const NO_CONTEXT_REPLY = 'Ask one clarifying question; never guess.';

/** Compact board digest — the model sees cards, not raw rows. */
function digest(
  items: BoardItem[],
  connectors: BoardConnector[],
  messages: InterviewMessageRow[],
  openDecisions: string[],
): string {
  const cov = boardCoverage(items, connectors, openDecisions);
  const cards = items
    .filter((i) => i.status === 'active')
    .map((i) => {
      const bits = [
        `id=${i.id}`,
        `kind=${i.kind}${i.note_kind ? `/${i.note_kind}` : ''}`,
        i.title ? `title=${JSON.stringify(i.title.slice(0, 80))}` : null,
        i.body ? `body=${JSON.stringify(i.body.slice(0, 200))}` : null,
        i.zone ? `zone=${i.zone}` : null,
        i.serves?.length ? `serves=[${i.serves.join(',')}]` : null,
        i.x != null && i.y != null
          ? `xy=(${Math.round(i.x)},${Math.round(i.y)})`
          : null,
      ];
      return `- ${bits.filter(Boolean).join(' ')}`;
    });
  const edges = connectors
    .filter((c) => c.status === 'active')
    .map(
      (c) =>
        `- ${c.id}: ${c.source_item_id} → ${c.target_item_id}${c.label ? ` (${c.label})` : ''}`,
    );
  const recent = messages
    .slice(-12)
    .map(
      (m) =>
        `- [${m.role}${m.created_by ? `:${m.created_by}` : ''}] ${m.content.slice(0, 200)}`,
    );
  return [
    `coverage: ${cov.typed}/${cov.total} typed, ${cov.goals} goals, ${cov.open_questions} open questions, ${cov.orphans} orphans, ${cov.open_decisions} open decisions`,
    'items:',
    ...(cards.length ? cards : ['- (empty board)']),
    'connectors:',
    ...(edges.length ? edges : ['- (none)']),
    openDecisions.length ? `open decisions: ${openDecisions.join(', ')}` : null,
    'recent thread:',
    ...(recent.length ? recent : ['- (new thread)']),
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

const SYSTEM_PREFIX = `You are the Board Assistant embedded on an idea board. You help the user build the board toward synthesis readiness. Every board change you want is a PROPOSAL — you never write the board yourself; a human accepts or rejects each proposal.

Respond with STRICT JSON only: {"reply": string, "ops": ProposalOp[]}.

ProposalOp (discriminated on "op", no extra keys):
- {"op":"create-item","kind"?:"note|text|link|zone","note_kind"?:"idea|want|avoid|problem|constraint|question|decision|feedback|comment","title"?:string,"body"?:string,"ref"?:string,"importance"?:"low|medium|high|critical","x"?:number,"y"?:number,"zone"?:string,"temp_id"?:string}
- {"op":"patch-item","id":string,"patch":{title?,body?,note_kind?,importance?,note_status?,topic?,rationale?,color?,ref?}}
- {"op":"move-item","id":string,"x"?:number,"y"?:number,"zone"?:string|null}
- {"op":"serve","id":string,"goal_item_id":string}
- {"op":"connect","source_item_id":string,"target_item_id":string,"label"?:string}
- {"op":"connector-remove","id":string}
- {"op":"delete-item","id":string}

Rules: reference existing items by their id= values; omit x/y to let the engine place creates; "serve" wires an item TO a goal (serves target = the goal); if the request is ambiguous return ops:[] and ${NO_CONTEXT_REPLY}

Same-reply references: to point at an item you are creating in THIS reply, give its create-item op a "temp_id" string (e.g. "frame-1") and use that string in another op's "zone", "source_item_id", "target_item_id", "goal_item_id", or "id". Emit the create-item op BEFORE ops that reference its temp_id. Example — a frame holding three linked notes: {"op":"create-item","kind":"zone","title":"…","temp_id":"frame-1","w":900,"h":400}, then three {"op":"create-item","kind":"note","temp_id":"n-1"|"n-2"|"n-3","zone":"frame-1",…}, then {"op":"connect","source_item_id":"n-1","target_item_id":"n-2"} etc. Never invent ids for existing items and never reuse a temp_id across replies.`;

export interface ConverseResult {
  reply: string;
  ops: ProposalOp[];
  /** True when the provider output failed validation — ops dropped. */
  malformed: boolean;
}

/**
 * One command-mode turn. Pure w.r.t. the board — returns ops for the
 * caller to draft as proposals; never mutates board_items.
 */
export async function converse(
  ctx: AssistantCtx,
  args: {
    board: string;
    sessionId: string;
    text: string;
    openDecisions?: string[];
  },
): Promise<ConverseResult> {
  if (!ctx.provider) {
    return { reply: NO_PROVIDER_REPLY, ops: [], malformed: false };
  }
  const [items, connectors, messages] = await Promise.all([
    ctx.store.listBoardItems({
      workspace: ctx.workspace,
      board: args.board,
    }),
    ctx.store.listBoardConnectors({
      workspace: ctx.workspace,
      board: args.board,
    }),
    transcript(ctx, args.sessionId),
  ]);
  const prompt: ConverseMessage[] = [
    {
      role: 'system',
      content: `${SYSTEM_PREFIX}\n\nBoard state:\n${digest(items, connectors, messages, args.openDecisions ?? [])}`,
    },
    { role: 'user', content: args.text },
  ];
  const raw = await ctx.provider.converse(prompt, {
    jsonSchema: {
      name: 'converse_output',
      schema: {
        type: 'object',
        properties: {
          reply: { type: 'string' },
          ops: { type: 'array' },
        },
        required: ['reply'],
        additionalProperties: false,
      },
    },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: MALFORMED_REPLY, ops: [], malformed: true };
  }
  const out = ConverseOutputSchema.safeParse(parsed);
  if (!out.success) {
    return { reply: MALFORMED_REPLY, ops: [], malformed: true };
  }
  return { reply: out.data.reply, ops: out.data.ops, malformed: false };
}

// ---- /critique LLM augmentation (wp-167 skills polish) -------------

/** LLM critique output — same closed kind set as the deterministic
 *  findings; anything else fails closed and the deterministic floor
 *  still stands. */
const CRITIQUE_KINDS = [
  'vague',
  'untyped',
  'orphan',
  'unanswered-question',
  'missing-kind',
  'no-goals',
  'open-decision',
] as const;

const CritiqueLlmOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            kind: z.enum(CRITIQUE_KINDS),
            item_id: z.string().optional(),
            detail: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Provider-augmented critique (TDD "Skills" — LLM findings merge with
 * the deterministic checks). Returns ONLY new findings — deduped
 * against `existing` on (kind,item_id) and normalized detail, and
 * against itself; `item_id`s that don't resolve to a real item are
 * dropped. Fail-closed on every error path: a provider/parse failure
 * yields `[]`, never a guessed finding.
 */
export async function llmCritiqueFindings(
  ctx: AssistantCtx,
  args: {
    items: BoardItem[];
    connectors: BoardConnector[];
    openDecisions: string[];
    existing: CritiqueFinding[];
  },
): Promise<CritiqueFinding[]> {
  if (!ctx.provider) return [];
  const itemIds = new Set(
    args.items.filter((i) => i.status !== 'discarded').map((i) => i.id),
  );
  const prompt: ConverseMessage[] = [
    {
      role: 'system',
      content: `You are the Board Assistant's critique pass on an idea board. Report NEW findings only — the deterministic pass already reported the ones listed; do not repeat them.\n\nRespond with STRICT JSON only: {"findings":[{"kind":"vague|untyped|orphan|unanswered-question|missing-kind|no-goals|open-decision","item_id"?:string,"detail":string}]}.\n\nRules: item_id must reference an existing id= value or be omitted; detail is one actionable sentence; findings only — no writes, no proposals.\n\nBoard state:\n${digest(args.items, args.connectors, [], args.openDecisions)}\n\nAlready reported:\n${args.existing.map((f) => `- ${f.kind}${f.item_id ? ` (${f.item_id})` : ''}: ${f.detail}`).join('\n') || '- (none)'}`,
    },
    { role: 'user', content: 'List additional findings, or {"findings":[]}.' },
  ];
  let parsed: unknown;
  try {
    const raw = await ctx.provider.converse(prompt, {
      jsonSchema: {
        name: 'critique_findings',
        schema: {
          type: 'object',
          properties: { findings: { type: 'array' } },
          required: ['findings'],
          additionalProperties: false,
        },
      },
    });
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out = CritiqueLlmOutputSchema.safeParse(parsed);
  if (!out.success) return [];

  const seen = new Set(
    args.existing.map((f) => `${f.kind}|${f.item_id ?? ''}`),
  );
  const seenDetail = new Set(
    args.existing.map((f) => norm(f.detail).slice(0, 60)),
  );
  const fresh: CritiqueFinding[] = [];
  for (const f of out.data.findings) {
    const key = `${f.kind}|${f.item_id ?? ''}`;
    const detailKey = norm(f.detail).slice(0, 60);
    if (seen.has(key) || seenDetail.has(detailKey)) continue;
    if (f.item_id !== undefined && !itemIds.has(f.item_id)) continue;
    seen.add(key);
    seenDetail.add(detailKey);
    fresh.push({
      kind: f.kind,
      ...(f.item_id !== undefined ? { item_id: f.item_id } : {}),
      detail: f.detail,
    });
  }
  return fresh;
}
