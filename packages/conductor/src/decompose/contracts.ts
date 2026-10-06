/**
 * decompose/contracts.ts — contract-first tickets (PRD §15.7/§15.10,
 * wp-154).
 *
 * When a split's children share interfaces, the split run writes one
 * `contracts/<name>.json` run artifact per shared contract (a
 * ContractSpec doc). Split-plan approval promotes each contract into
 * a `contract.json` doc_version on EVERY consuming child ticket —
 * landing BEFORE any implement run, so launch pins
 * `runs.request.baseline.contract_ver` against it (wp-141) and
 * mid-run drift revalidates instead of silently proceeding
 * (reconcile/baseline.ts).
 */
import {
  type ContractDoc,
  type ContractSpec,
  ContractSpecSchema,
} from '@sprint-runner/core';
import type { TransitionContext } from '../contracts.js';
import type { PlanContract } from './plan.js';

/** Read + validate one contract artifact. Null when absent or
 *  malformed — callers decide whether absence is a violation
 *  (fail-closed at both proposal and materialization). */
export function parseContractArtifact(content: string): ContractSpec | null {
  try {
    const res = ContractSpecSchema.safeParse(JSON.parse(content));
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

/** Render the per-ticket `contract.json` doc_version envelope. */
export function renderContractDoc(specs: ContractSpec[]): string {
  const doc: ContractDoc = { schema: 1, contracts: specs };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface PromotedContract {
  /** Contract name (the `## Contracts` row key). */
  name: string;
  /** Ticket ids the doc_version landed on (consuming children). */
  consumers: string[];
  /** doc_version written (per consumer — same content, per-subject
   *  versions). */
  version: number;
}

/**
 * Promote the plan's contract artifacts to `contract.json` doc_versions
 * on each consuming child. Runs INSIDE the materialization
 * transaction — a missing/invalid artifact throws (fail-closed: an
 * approved plan that names a contract must produce a real pinned doc,
 * never a half-promoted split).
 *
 * `readArtifact` resolves a run-artifact relpath against the parent
 * ticket's runs (the caller passes `ticketArtifactText` bound to the
 * tx store — decompose/ stays one-directional, never importing
 * transitions/actions).
 */
export async function promoteContracts(args: {
  ctx: TransitionContext;
  /** The split parent's ticket id (artifact scope). */
  ticketId: string;
  contracts: PlanContract[];
  /** label → real child ticket id. */
  ids: Record<string, string>;
  readArtifact: (name: string) => Promise<string | null>;
}): Promise<PromotedContract[]> {
  const { ctx, ticketId, contracts, ids, readArtifact } = args;
  // spec per consumer ticket: name → ContractSpec (one doc per ticket).
  const perTicket = new Map<string, ContractSpec[]>();
  const promoted: PromotedContract[] = [];
  for (const contract of contracts) {
    const raw = await readArtifact(contract.artifact);
    const spec = raw === null ? null : parseContractArtifact(raw);
    if (!spec) {
      throw new Error(
        `promoteContracts: contract '${contract.name}' artifact '${contract.artifact}' missing or invalid for ${ticketId} (fail-closed — an approved contract must produce a pinned doc)`,
      );
    }
    for (const label of contract.consumers) {
      const consumerId = ids[label];
      if (!consumerId) {
        throw new Error(
          `promoteContracts: contract '${contract.name}' names unknown consumer '${label}' (fail-closed)`,
        );
      }
      const list = perTicket.get(consumerId) ?? [];
      list.push({ ...spec, consumers: [...contract.consumers] });
      perTicket.set(consumerId, list);
    }
  }
  for (const [consumerId, specs] of perTicket) {
    const v = await ctx.store.appendDocVersion(
      { workspace: ctx.workspace, subject: consumerId, doc: 'contract.json' },
      renderContractDoc(specs),
      ctx.actor,
    );
    for (const s of specs) {
      promoted.push({
        name: s.name,
        consumers: [consumerId],
        version: v.version,
      });
    }
  }
  return promoted;
}
