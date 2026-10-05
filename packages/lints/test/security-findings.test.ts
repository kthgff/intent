import { describe, expect, it } from 'vitest';
import { securityFindingLint } from '../src/index.js';

describe('securityFindingLint', () => {
  it('accepts a complete security finding', () => {
    expect(
      securityFindingLint([
        {
          thread_id: 'f-aaaa',
          category: 'security',
          security_category: 'secrets',
          affected_asset: 'src/config.ts',
        },
      ]),
    ).toEqual([]);
  });

  it('ignores non-security findings', () => {
    expect(
      securityFindingLint([
        { thread_id: 'f-1', category: 'correctness', body: 'off-by-one' },
      ]),
    ).toEqual([]);
  });

  it('flags a missing security_category (fail-closed)', () => {
    const v = securityFindingLint([
      { thread_id: 'f-2', category: 'security', affected_asset: 'a.ts' },
    ]);
    expect(v.map((x) => x.rule)).toEqual(['security.missing-category']);
  });

  it('flags an unknown security_category', () => {
    const v = securityFindingLint([
      {
        thread_id: 'f-3',
        category: 'security',
        security_category: 'not-a-category',
        affected_asset: 'a.ts',
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(['security.bad-category']);
  });

  it('falls back to `file` for the asset, else flags it', () => {
    expect(
      securityFindingLint([
        {
          thread_id: 'f-4',
          category: 'security',
          security_category: 'injection',
          file: 'src/q.ts',
        },
      ]),
    ).toEqual([]);
    const v = securityFindingLint([
      {
        thread_id: 'f-5',
        category: 'security',
        security_category: 'injection',
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(['security.missing-asset']);
  });

  it('treats a security_category-only finding as security too', () => {
    const v = securityFindingLint([
      { thread_id: 'f-6', security_category: 'secrets' },
    ]);
    // has category via security_category; missing asset.
    expect(v.map((x) => x.rule)).toEqual(['security.missing-asset']);
  });

  it('fails closed on a non-array payload', () => {
    expect(securityFindingLint('nope').map((x) => x.rule)).toEqual([
      'security.malformed',
    ]);
  });
});
