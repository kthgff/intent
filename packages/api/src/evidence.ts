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
import type { EffectiveConfig } from '@sprint-runner/config';
import type { Store } from '@sprint-runner/core';
import { git } from '@sprint-runner/gitops';
import { createEmbedder, indexRepo, queryEvidence } from '@sprint-runner/kb';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

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

  // ---- hybrid evidence search -------------------------------------------

  app.post('/api/v1/evidence/search', async (req) => {
    const body = SearchBody.parse(req.body ?? {});
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
