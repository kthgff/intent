/**
 * align/feedback.ts — semantic clustering for captured feedback
 * (wp-112, INTELLIGENCE §8 Phase B "feedback clustering").
 *
 * Feedback board_items (`kind: 'feedback'`) are clustered with the
 * wp-139 clusterer (metadata Jaccard + optional embeddings). Output is
 * PROPOSALS ONLY: the function never creates board items, tickets, or
 * initiatives — it returns cluster proposals (and emits one
 * `feedback_cluster_proposed` event per cluster) so a human converts
 * them deliberately. Original item refs are preserved verbatim in
 * `members`.
 *
 * Clustering is strictly workspace-scoped: items come from
 * `listBoardItems({workspace})`, so similar feedback in two workspaces
 * never merges into one cluster (wp-112 test plan).
 */
import type { BoardItem, Store } from '@sprint-runner/core';
import { type Cluster, clusterItems } from '../semantics/cluster.js';

export interface FeedbackCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
}

export interface FeedbackClusterProposal {
  /** Deterministic cluster id (sorted member ids joined). */
  cluster_id: string;
  /** Original board_item refs — preserved verbatim, never rewritten. */
  members: string[];
  member_titles: (string | null)[];
  reason: Cluster['reason'];
  similarity: number;
  duplicate: boolean;
  /** What a human could do with this cluster — a proposal shape only;
   *  nothing here has been created. */
  proposal: {
    kind: 'board-item';
    board_type: 'feedback';
    title: string;
  };
  requires_human: true;
}

export interface ClusterFeedbackArgs {
  /** Optional board slug — restrict to one feedback board. */
  board?: string;
  /** Similarity threshold override (default 0.45 — feedback text is
   *  shorter/noisier than import items). */
  threshold?: number;
  /** Optional embeddings keyed by board_item id (same model). */
  embeddings?: Record<string, number[]>;
}

export async function clusterFeedback(
  ctx: FeedbackCtx,
  args: ClusterFeedbackArgs = {},
): Promise<FeedbackClusterProposal[]> {
  const items = await ctx.store.listBoardItems({
    workspace: ctx.workspace,
    kind: 'feedback',
    ...(args.board !== undefined ? { board: args.board } : {}),
  });
  const clusters = clusterItems(
    items.map((i: BoardItem) => ({
      id: i.id,
      title: i.title ?? i.body ?? i.id,
      body: i.body ?? null,
      relations: i.applies_to ?? [],
      embedding: args.embeddings?.[i.id] ?? null,
    })),
    { threshold: args.threshold ?? 0.45 },
  );

  const byId = new Map(items.map((i) => [i.id, i]));
  const proposals: FeedbackClusterProposal[] = clusters.map((c) => ({
    cluster_id: c.id,
    members: c.members,
    member_titles: c.members.map((m) => byId.get(m)?.title ?? null),
    reason: c.reason,
    similarity: c.similarity,
    duplicate: c.duplicate,
    proposal: {
      kind: 'board-item',
      board_type: 'feedback',
      title: `Feedback cluster (${c.members.length} items): ${byId.get(c.members[0] ?? '')?.title ?? c.id}`,
    },
    requires_human: true,
  }));

  // Ledger the proposals — one event per cluster so the audit trail
  // names exactly which member refs were grouped. Nothing is created.
  const at = ctx.now().toISOString();
  for (const p of proposals) {
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts: at,
      stage: null,
      actor_type: 'system',
      actor_id: ctx.actor,
      event: 'feedback_cluster_proposed',
      run: null,
      refs: p.members.map((m) => `board-item:${m}`),
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        cluster_id: p.cluster_id,
        members: p.members,
        reason: p.reason,
        similarity: p.similarity,
        duplicate: p.duplicate,
        requires_human: true,
      },
    });
  }
  return proposals;
}
