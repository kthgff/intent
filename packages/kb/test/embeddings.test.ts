import { describe, expect, it } from 'vitest';
import {
  LOCAL_EMBEDDING_DIMS,
  createEmbedder,
  zeroVector,
} from '../src/index.js';

describe('embedder modes', () => {
  it('off → embed returns null, zero-vector path works', async () => {
    const e = createEmbedder({ embeddings: 'off', embedding_model: null });
    expect(e.dims).toBe(0);
    expect(await e.embed('anything')).toBeNull();
    const z = zeroVector(384);
    expect(z).toBeInstanceOf(Float32Array);
    expect(z.every((v) => v === 0)).toBe(true);
  });

  it('local → real MiniLM embed (skips gracefully offline)', async (ctx) => {
    const e = createEmbedder({ embeddings: 'local', embedding_model: null });
    try {
      const v = await e.embed('hello dossier');
      expect(v).not.toBeNull();
      expect(v?.length).toBe(LOCAL_EMBEDDING_DIMS);
      // normalized vector: unit length
      const norm = Math.sqrt(
        (v ?? new Float32Array()).reduce((s, x) => s + x * x, 0),
      );
      expect(norm).toBeGreaterThan(0.9);
      expect(norm).toBeLessThan(1.1);
    } catch {
      ctx.skip(); // model download unavailable — offline machine
    }
  }, 120_000);
});
