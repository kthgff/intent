/**
 * cards.ts — repo-card overlay (wp-099 spec-gap resolution).
 *
 * Repo cards live at `<repo>/.sprint-runner/card.json`, written by the
 * conductor's own `probe:<repo>` runs (CONDUCTOR "repo-card rule",
 * SETTINGS auto-probe). CLAIM checks `deps.config.repos[name].card
 * .verified` — but nothing else ever loads card.json back into the
 * effective config, so without this overlay a probed card is never
 * seen and every repo-executing stage re-probes forever.
 *
 * The daemon overlays card.json → `config.repos[name].card` at boot
 * and before every tick; `tick`/`doctor` share the same helper. A
 * malformed card.json is skipped with a warning (the next probe
 * overwrites it — self-healing).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ConductorWorkspace } from '@sprint-runner/conductor';
import type { EffectiveConfig } from '@sprint-runner/config';
import { type RepoCard, RepoCardSchema } from '@sprint-runner/core';

export interface CardOverlayResult {
  /** Repos whose config card was (re)applied from card.json. */
  applied: string[];
  warnings: string[];
}

/**
 * Overlay `<repo>/.sprint-runner/card.json` onto `config.repos[*].card`
 * in place. `workspaces` anchors relative `repos.<name>.path` entries
 * (resolveRepoPath semantics — first workspace hit wins).
 */
export async function overlayRepoCards(
  config: EffectiveConfig,
  workspaces: ConductorWorkspace[],
): Promise<CardOverlayResult> {
  const out: CardOverlayResult = { applied: [], warnings: [] };
  for (const [name, repo] of Object.entries(config.repos)) {
    const candidates = isAbsolute(repo.path)
      ? [repo.path]
      : workspaces.map((ws) => resolve(ws.rootPath, repo.path));
    for (const dir of candidates) {
      const cardPath = join(dir, '.sprint-runner', 'card.json');
      let parsed: unknown;
      try {
        parsed = RepoCardSchema.partial().parse(
          JSON.parse(await readFile(cardPath, 'utf8')),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (e instanceof SyntaxError) {
          out.warnings.push(
            `repo '${name}': malformed ${cardPath} — ignored (next probe rewrites it)`,
          );
          continue;
        }
        out.warnings.push(
          `repo '${name}': ${cardPath} failed validation — ignored (${(e as Error).message.split('\n')[0]})`,
        );
        continue;
      }
      // Re-validate through the full schema — defaults fill
      // verified/forbidden_paths; an invalid merge warns + skips
      // (fail-closed, same as a malformed card).
      try {
        repo.card = RepoCardSchema.parse({
          ...(repo.card ?? {}),
          ...(parsed as Partial<RepoCard>),
        });
      } catch (e) {
        out.warnings.push(
          `repo '${name}': ${cardPath} failed validation — ignored (${(e as Error).message.split('\n')[0]})`,
        );
        continue;
      }
      out.applied.push(name);
      break;
    }
  }
  return out;
}
