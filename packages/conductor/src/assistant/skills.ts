/**
 * assistant/skills.ts — the v1 skill surface + suggestion chips
 * (TDD "Skills", PRD R7).
 *
 * Chips are deterministic nudges — never LLM output, never a chat
 * message. `/organize` and `/import` are out of v1 scope (PRD).
 */
import type { AssistantSkillInfo, BoardItem } from '@veto/core';
import { servesTargetIds } from './types.js';

export const ASSISTANT_SKILLS_INFO: AssistantSkillInfo[] = [
  {
    skill: 'interview',
    label: '/interview',
    description:
      'Goals first, then the weakest coverage — one question at a time, you decide when it ends',
  },
  {
    skill: 'expand',
    label: '/expand',
    description: 'Mini-interview scoped to the current selection',
  },
  {
    skill: 'critique',
    label: '/critique',
    description:
      'Vague items, contradictions, coverage gaps, orphans — findings + proposals, never writes',
  },
];

/** Parse `/skill rest…` — returns null when `text` isn't a command. */
export function parseSkillCommand(
  text: string,
): { skill: string; arg: string } | null {
  const m = /^\/(\S+)(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  return { skill: (m[1] ?? '').toLowerCase(), arg: (m[2] ?? '').trim() };
}

/** One suggestion chip — `command` is the text populated into the
 *  input on click; `''` marks a display-only chip (the action's route
 *  may not be live — the API layer strips it). */
export interface AssistantChip {
  id: 'interview' | 'resolve-decisions' | 'synthesize';
  label: string;
  command: string;
}

/**
 * `suggestChips` (TDD): no serves-target → `Run /interview`; open
 * decisions → `Resolve N` (critique surfaces them); `draft_ready` →
 * `Looks ready — synthesize?` (the scoped-synthesis route isn't live
 * in v1 — the API layer drops it).
 */
export function suggestChips(args: {
  items: BoardItem[];
  openDecisions: string[];
  draftReady: boolean;
}): AssistantChip[] {
  const chips: AssistantChip[] = [];
  if (servesTargetIds(args.items).size === 0) {
    chips.push({
      id: 'interview',
      label: 'Run /interview',
      command: '/interview',
    });
  }
  if (args.openDecisions.length > 0) {
    chips.push({
      id: 'resolve-decisions',
      label: `Resolve ${args.openDecisions.length} decision${args.openDecisions.length === 1 ? '' : 's'}`,
      command: '/critique',
    });
  }
  if (args.draftReady) {
    chips.push({
      id: 'synthesize',
      label: 'Looks ready — synthesize?',
      command: '',
    });
  }
  return chips;
}
