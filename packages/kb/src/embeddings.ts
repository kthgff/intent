/**
 * Embeddings (SCHEMAS §12, SETTINGS `semantic:`) — the vector side of
 * the knowledge base. Powers prior-art recall, near-dup detection, and
 * dossier-section retrieval via `Store.nearestEmbeddings`.
 *
 * Spike decision (TRACKER D12, docs/EMBEDDINGS.md): a bundled
 * MiniLM-class encoder IS feasible — `@huggingface/transformers` loads
 * `Xenova/all-MiniLM-L6-v2` (384-dim) in ~2.4s on a desktop Node 23
 * context and embeds mean-pooled normalized vectors in-process. So:
 *
 * - `local`     → transformers.js feature-extraction pipeline, real
 *   local path. The model downloads once to the HF cache on first use;
 *   a machine with no network fails at first `embed()` — callers
 *   wanting guaranteed operation use `off`.
 * - `openrouter`→ POST /api/v1/embeddings; key from
 *   `OPENROUTER_API_KEY` (env only — secrets never in config).
 * - `off`       → `embed()` returns null; all zero-vector code paths
 *   still execute (nearestEmbeddings scans happily on whatever vectors
 *   exist — callers just skip writes/lookups).
 */
import type { SemanticConfig } from '@veto/core';

/** Bundled local model (spike-verified; 384 dims, fp32, ~90MB). */
export const LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBEDDING_DIMS = 384;

/** Default remote model when `semantic.embeddings: openrouter`. */
export const OPENROUTER_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const OPENROUTER_EMBEDDING_DIMS = 1536;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/embeddings';

export interface Embedder {
  /** The `model` value stamped on `embeddings` rows. */
  readonly model: string;
  /** Vector dimensionality (0 when `off`). */
  readonly dims: number;
  /** Embed one text. `off` → null (zero-vector path: callers skip). */
  embed(text: string): Promise<Float32Array | null>;
}

/** A zero vector — what `off`-mode callers can safely store/compare. */
export function zeroVector(dims: number): Float32Array {
  return new Float32Array(dims);
}

/** Off-mode embedder: every call resolves to null, never throws. */
const offEmbedder: Embedder = {
  model: 'none',
  dims: 0,
  embed: async () => null,
};

/** transformers.js pipeline handle (lazy — the dep + model load are
 *  deferred until the first embed so `off`/remote users never pay). */
type FeatureExtractor = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

function localEmbedder(model: string): Embedder {
  let extractorPromise: Promise<FeatureExtractor> | null = null;
  const load = (): Promise<FeatureExtractor> => {
    extractorPromise ??= import('@huggingface/transformers').then(
      (m) =>
        m.pipeline('feature-extraction', model, {
          dtype: 'fp32',
        }) as Promise<unknown> as Promise<FeatureExtractor>,
    );
    return extractorPromise;
  };
  return {
    model,
    dims: LOCAL_EMBEDDING_DIMS,
    async embed(text) {
      const extractor = await load();
      const out = await extractor(text, {
        pooling: 'mean',
        normalize: true,
      });
      return Float32Array.from(out.data);
    },
  };
}

function openrouterEmbedder(model: string, apiKey: string | undefined) {
  return {
    model,
    dims: OPENROUTER_EMBEDDING_DIMS,
    async embed(text: string): Promise<Float32Array> {
      const key = apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw new Error(
          'semantic.embeddings=openrouter but OPENROUTER_API_KEY is not set',
        );
      }
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error(
          `openrouter embeddings failed: ${res.status} ${await res.text()}`,
        );
      }
      const body = (await res.json()) as {
        data?: { embedding?: number[] }[];
      };
      const vec = body.data?.[0]?.embedding;
      if (!vec) {
        throw new Error('openrouter embeddings: empty response');
      }
      return Float32Array.from(vec);
    },
  } satisfies Embedder;
}

/**
 * Build the embedder for `semantic:` config. `embedding_model` overrides
 * the provider default (`local` → bundled MiniLM, `openrouter` →
 * text-embedding-3-small). `off` always works — no deps, no network.
 */
export function createEmbedder(
  semantic: Pick<SemanticConfig, 'embeddings' | 'embedding_model'>,
  opts: { apiKey?: string } = {},
): Embedder {
  switch (semantic.embeddings) {
    case 'off':
      return offEmbedder;
    case 'openrouter':
      return openrouterEmbedder(
        semantic.embedding_model ?? OPENROUTER_EMBEDDING_MODEL,
        opts.apiKey,
      );
    default:
      return localEmbedder(semantic.embedding_model ?? LOCAL_EMBEDDING_MODEL);
  }
}
