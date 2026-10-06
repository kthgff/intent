/** wp-154 contract lint + split-plan optional-section lint tests. */
import { describe, expect, it } from 'vitest';
import {
  contractDocLint,
  contractLint,
  structuredDocLint,
} from '../src/index.js';

const SPEC = JSON.stringify({
  schema: 1,
  name: 'billing-api',
  kind: 'api',
  version: 1,
  summary: 'charge surface',
  terms: { endpoints: ['POST /billing/charge'] },
});

const PLAN = [
  '# Split plan — SR-0001',
  '## Children',
  '| child | title | repos | depends_on | covers |',
  '| --- | --- | --- | --- | --- |',
  '| c1 | part one | code-repo | | ac1 |',
  '| c2 | part two | code-repo | c1 | ac2 |',
].join('\n');

describe('contract lint (wp-154)', () => {
  it('accepts a valid ContractSpec artifact / ContractDoc envelope', () => {
    expect(contractLint(SPEC)).toEqual([]);
    const doc = JSON.stringify({ schema: 1, contracts: [JSON.parse(SPEC)] });
    expect(contractDocLint(doc)).toEqual([]);
  });

  it('fails closed on non-JSON and schema misses', () => {
    expect(contractLint('not json').map((v) => v.rule)).toContain(
      'contract.json',
    );
    const vs = contractLint('{"schema":1,"name":"x","kind":"rpc"}');
    expect(vs.length).toBeGreaterThan(0);
    expect(vs[0]?.rule).toBe('contract.shape');
    // ContractDoc envelope requires ≥1 contract.
    expect(
      contractDocLint('{"schema":1,"contracts":[]}').length,
    ).toBeGreaterThan(0);
  });
});

describe('split-plan optional sections (wp-154)', () => {
  it('children-only plans lint clean', () => {
    expect(structuredDocLint('split-plan.md', PLAN)).toEqual([]);
  });

  it('accepts well-formed Contracts + Decomposition tables', () => {
    const plan = `${PLAN}
## Contracts
| contract | kind | consumers | artifact |
| --- | --- | --- | --- |
| billing-api | api | c1, c2 | contracts/billing-api.json |
## Decomposition
| child | boundary | ownership | tests | security | complexity | shared_files |
| --- | --- | --- | --- | --- | --- | --- |
| c1 | writes | backend/billing | unit | sensitive | high | code-repo:src/x.ts |
`;
    expect(structuredDocLint('split-plan.md', plan)).toEqual([]);
  });

  it('fails closed on a present-but-malformed optional section', () => {
    const noTable = `${PLAN}\n## Contracts\njust prose\n`;
    expect(
      structuredDocLint('split-plan.md', noTable).map((v) => v.rule),
    ).toContain('doc.table');
    const badHeader = `${PLAN}\n## Decomposition\n| a | b |\n| --- | --- |\n| x | y |\n`;
    expect(
      structuredDocLint('split-plan.md', badHeader).map((v) => v.rule),
    ).toContain('doc.table');
  });

  it('flags enum cells outside the pinned vocabularies', () => {
    const badKind = `${PLAN}\n## Contracts\n| contract | kind | consumers | artifact |\n| --- | --- | --- | --- |\n| billing-api | rpc | c1 | contracts/b.json |\n`;
    expect(structuredDocLint('split-plan.md', badKind).length).toBeGreaterThan(
      0,
    );
    const badSecurity = `${PLAN}\n## Decomposition\n| child | boundary | ownership | tests | security | complexity | shared_files |\n| --- | --- | --- | --- | --- | --- | --- |\n| c1 | x | y | z | scary | low | |\n`;
    expect(
      structuredDocLint('split-plan.md', badSecurity).length,
    ).toBeGreaterThan(0);
  });
});
