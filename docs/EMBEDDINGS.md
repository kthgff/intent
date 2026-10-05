# EMBEDDINGS — local-encoder spike findings (TRACKER D12)

> D37 scope note (2026-10-04): embeddings are one retrieval signal inside the
> hybrid evidence plane defined by `INTELLIGENCE.md`; they do not replace exact
> search, commit-pinned citations, explicit/structural relations, or reading
> current files. Raw telemetry events are never embedded—only sanitized,
> deduplicated signatures/summaries and verified incident resolutions.

wp-070, 2026-10-04. Decision: **`local` is a real bundled local path** —
the spike passed, no fallback indirection needed.

## Spike

| Candidate | Result |
| --- | --- |
| `@huggingface/transformers` (transformers.js v4, onnxruntime-node
under the hood) | ✅ `pnpm add` clean (~41 packages); `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {dtype:'fp32'})` loaded in **~2.4s** on Node 23/macOS; mean-pooled + normalized output = **384-dim Float32Array**. Model (~90MB) downloads once to the HF cache on first call — no download, no API spend at steady state, matching SETTINGS' "bundled MiniLM-class encoder" intent. |
| onnxruntime-node direct | Not needed — transformers.js wraps it. |

## Chosen implementation (`packages/kb/src/embeddings.ts`)

- `semantic.embeddings: local` → `Xenova/all-MiniLM-L6-v2` via a lazily
  loaded transformers.js pipeline (`createEmbedder` defers both the dep
  import and the model load until first `embed()`).
- `semantic.embeddings: openrouter` → `POST /api/v1/embeddings`
  (default `openai/text-embedding-3-small`); key from
  `OPENROUTER_API_KEY` env only.
- `semantic.embeddings: off` → `embed()` returns `null`; all callers
  treat null as "skip writes/lookups" (`zeroVector(dims)` provided for
  zero-vector code paths). Fully functional, no deps, no network.
- `semantic.embedding_model` overrides the provider default in either
  live mode.

## Caveats

- First `embed()` on a fresh machine needs HF-hub access for the model
  download (~90MB); offline machines get a load error at first embed —
  use `off` there. The model is then cached.
- `nearestEmbeddings` is an in-process cosine scan — O(n), fine at KB
  scale; swap to `pgvector` when the Postgres store lands (D29 —
  DB-SCHEMA: pgvector where available, else bytea + app-side cosine).
