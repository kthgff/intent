import { isAbsolute, resolve } from 'node:path';
/**
 * api/evidence.ts — D37 evidence + repository-index routes (wp-110).
 *
 *   GET  /repositories/<ws>/<repo>/index — repo_index heads + status
 *   POST /repositories/<ws>/<repo>/index — index the repo's current
 *        HEAD (the checkout path comes from config.repos, never the
 *        request body — API.md "never accepts arbitrary filesystem
 *        paths")
 *   POST /evidence/search — permission-filtered hybrid retrieval →
 *        retrieval-evidence.json. The authorized repo set is derived
 *        server-side (config.repos ∩ the subject ticket's repos when a
 *        subject is given); a client repo outside the ACL is a 403,
 *        never a silent drop.
 */
import type { EffectiveConfig } from '@veto/config';
import type { Store } from '@veto/core';
import { git } from '@veto/gitops';
import { createEmbedder, indexRepo, queryEvidence } from '@veto/kb';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parseBody } from './server.js';

const SourceQuery = z.object({
  workspace: z.string().min(1),
  /** `code:<repo>:<sha>:<path>:<symbol|L<start>-<end>>` citation
   *  (SCHEMAS §17 object_ref) — or an `ev_<id>` handled by the caller
   *  resolving through the run's retrieval-evidence.json first. */
  ref: z.string().min(1),
});

const CODE_REF = /^code:([A-Za-z0-9_.\-/]+):([0-9a-f]{7,40}):([^:]+):(.+)$/;

const SearchBody = z
  .object({
    workspace: z.string().min(1),
    subject: z.string().nullish(),
    task: z
      .enum([
        'prd',
        'impact',
        'testplan',
        'implement',
        'review',
        'alignment',
        'incident',
      ])
      .default('implement'),
    query: z.string().min(1),
    repos: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(100).default(20),
    token_limit: z.number().int().positive().max(100_000).default(8000),
    commit_policy: z.enum(['current', 'allow-stale']).default('current'),
  })
  .passthrough();

export interface EvidenceRouteDeps {
  store: Store;
  config: EffectiveConfig;
  /** Resolve a workspace name → its configured rootPath. */
  workspaceRoot: (name: string) => string | undefined;
  /** Configured repo names for the workspace's ACL. */
  repoPath: (workspace: string, repo: string) => string | undefined;
  notify?: (event: { type: string; payload: unknown }) => void;
  now: () => string;
}

function repoCheckoutPath(
  deps: EvidenceRouteDeps,
  workspace: string,
  repo: string,
): string {
  const p = deps.repoPath(workspace, repo);
  if (!p) {
    throw new ApiError(404, 'not_found', `repo '${repo}' is not configured`);
  }
  const root = deps.workspaceRoot(workspace) ?? '/';
  return isAbsolute(p) ? p : resolve(root, p);
}

export function registerEvidenceRoutes(
  app: FastifyInstance,
  deps: EvidenceRouteDeps,
): void {
  // ---- index heads + status -------------------------------------------

  app.get('/api/v1/repositories/:workspace/:repo/index', async (req) => {
    const { workspace, repo } = req.params as {
      workspace: string;
      repo: string;
    };
    const heads = await deps.store.listRepoIndexes({ workspace, repo });
    const current = await deps.store.getCurrentRepoIndex(workspace, repo);
    return { repo, current, heads };
  });

  app.post(
    '/api/v1/repositories/:workspace/:repo/index',
    async (req, reply) => {
      const { workspace, repo } = req.params as {
        workspace: string;
        repo: string;
      };
      // The checkout path is derived from config.repos — the request
      // body can never steer the indexer at an arbitrary directory.
      const checkoutDir = repoCheckoutPath(deps, workspace, repo);
      let commitSha: string;
      try {
        const { stdout } = await git(['rev-parse', 'HEAD'], {
          cwd: checkoutDir,
        });
        commitSha = stdout.trim();
      } catch (e) {
        throw new ApiError(
          502,
          'git_error',
          `cannot resolve HEAD in ${repo}: ${(e as Error).message}`,
        );
      }
      const embedder = createEmbedder(
        deps.config.semantic,
        deps.config.secrets.OPENROUTER_API_KEY
          ? { apiKey: deps.config.secrets.OPENROUTER_API_KEY }
          : {},
      );
      const result = await indexRepo(deps.store, {
        workspace,
        repo,
        checkoutDir,
        commitSha,
        embedder,
        notify: (e) => deps.notify?.(e),
        now: deps.now,
      });
      return reply.status(201).send(result);
    },
  );

  // ---- citation navigation (wp-111) --------------------------------------
  //
  // GET /evidence/source — resolve a `code:` citation to the pinned
  // unit's content + freshness. Fail-closed: unparsable ref → 400,
  // unconfigured repo → 403, missing units → 404. `freshness` compares
  // the pin to the current index head — a stale citation renders as
  // such in the UI, never as current evidence (INTELLIGENCE §4.1).
  app.get('/api/v1/evidence/source', async (req) => {
    const q = parseBody(SourceQuery, req.query, 'evidence source');
    const m = CODE_REF.exec(q.ref);
    if (!m?.[1] || !m[2] || !m[3] || !m[4]) {
      throw new ApiError(
        400,
        'bad_request',
        `unparseable citation ref '${q.ref}' — expected code:<repo>:<sha>:<path>:<symbol|L<start>-<end>>`,
      );
    }
    const [, repo, sha, path, tail] = m;
    if (!deps.config.repos[repo]) {
      throw new ApiError(
        403,
        'forbidden',
        `citation repo '${repo}' is not configured`,
      );
    }
    const units = await deps.store.listCodeUnits({
      workspace: q.workspace,
      repo,
      commit_sha: sha,
      path,
    });
    if (units.length === 0) {
      throw new ApiError(
        404,
        'not_found',
        `no indexed unit for ${repo}@${sha.slice(0, 12)}:${path}`,
      );
    }
    const lineTail = /^L(\d+)-(\d+)$/.exec(tail);
    const unit =
      units.find((u) => u.symbol === tail) ??
      (lineTail
        ? units.find(
            (u) =>
              u.start_line === Number(lineTail[1]) &&
              u.end_line === Number(lineTail[2]),
          )
        : undefined) ??
      units[0];
    const head = await deps.store.getCurrentRepoIndex(q.workspace, repo);
    return {
      ref: q.ref,
      repo,
      commit_sha: sha,
      path,
      freshness:
        head && head.commit_sha === sha
          ? ('current' as const)
          : ('stale' as const),
      current_head: head?.commit_sha ?? null,
      unit: unit
        ? {
            symbol: unit.symbol ?? null,
            symbol_kind: unit.symbol_kind ?? null,
            start_line: unit.start_line,
            end_line: unit.end_line,
            content_hash: unit.content_hash,
            content: unit.content,
          }
        : null,
    };
  });

  // ---- hybrid evidence search -------------------------------------------

  app.post('/api/v1/evidence/search', async (req) => {
    const body = parseBody(SearchBody, req.body, 'evidence search');
    const configured = new Set(Object.keys(deps.config.repos ?? {}));

    // Authorized scope: the configured repos, narrowed to the subject
    // ticket's own repo list when a subject is supplied (a search for
    // SR-0001 can never reach a repo the ticket doesn't touch).
    let authorized = configured;
    if (body.subject) {
      const ticket = await deps.store.getTicket({
        workspace: body.workspace,
        ticket_id: body.subject,
      });
      authorized = new Set(
        [...configured].filter((r) => ticket?.repos.includes(r) ?? false),
      );
    }

    const illegal = body.repos.filter((r) => !authorized.has(r));
    if (illegal.length > 0) {
      // Fail-closed: a widening attempt is rejected, never silently
      // intersected away (API.md).
      throw new ApiError(
        403,
        'forbidden',
        `repos not in the authorized scope: ${illegal.join(', ')}`,
      );
    }

    const embedder = createEmbedder(
      deps.config.semantic,
      deps.config.secrets.OPENROUTER_API_KEY
        ? { apiKey: deps.config.secrets.OPENROUTER_API_KEY }
        : {},
    );
    return queryEvidence(
      deps.store,
      {
        workspace: body.workspace,
        subject: body.subject ?? null,
        task: body.task,
        query: body.query,
        repos: body.repos,
        source_types: ['code'],
        commit_policy: body.commit_policy,
        limit: body.limit,
        token_limit: body.token_limit,
      },
      { authorizedRepos: [...authorized], embedder },
    );
  });
}
