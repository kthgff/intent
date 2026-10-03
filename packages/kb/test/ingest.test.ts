import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestSurveyArtifacts, mergeEntityAlias } from '../src/index.js';

let dir: string;
let store: SqliteStore;
let runDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-kb-ingest-'));
  store = new SqliteStore(`sqlite://${join(dir, 'state.db')}`);
  runDir = join(dir, 'run');
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const DOSSIER_MD = `## Architecture map
HTTP api → service layer → pg store.

## Domain model
IngestionJob has states pending→running→done.

## Glossary
- IngestionJob: a scheduled import
- SyncTask: alias of IngestionJob
`;

const SEMANTIC_JSON = {
  entities: [
    {
      name: 'Ingestion Job',
      canonical: 'IngestionJob',
      kind: 'entity',
      aliases: ['SyncTask'],
      evidence: 'src/jobs/ingest.ts:12',
    },
    { name: 'Admin', kind: 'persona' },
  ],
  relations: [
    {
      subject: 'SyncTask',
      predicate: 'part-of',
      object: 'IngestionJob',
      evidence: 'src/jobs/ingest.ts:40',
    },
  ],
};

describe('ingestSurveyArtifacts', () => {
  it('writes dossier sections + entities + relations', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'dossier.md'), DOSSIER_MD);
    writeFileSync(join(runDir, 'semantic.json'), JSON.stringify(SEMANTIC_JSON));
    const res = await ingestSurveyArtifacts(runDir, store, {
      scope: 'product',
      name: 'myApp',
      surveyedAt: '2026-10-04T00:00:00Z',
    });
    expect(res.sections).toContain('architecture-map');
    expect(res.sections).toContain('domain-model');
    expect(res.entities).toBe(2);
    expect(res.relations).toBe(1);

    const dossier = await store.getDossier('product', 'myApp');
    expect(dossier).toHaveLength(3);
    expect(
      dossier.find((s) => s.section === 'architecture-map')?.content,
    ).toContain('pg store');

    const entities = await store.listEntities({ product: 'myApp' });
    expect(entities).toHaveLength(2);
    const job = entities.find((e) => e.canonical === 'IngestionJob');
    expect(job?.aliases).toContain('SyncTask');
    expect(job?.source).toBe('inferred');

    // Relation subject 'SyncTask' resolved to the merged entity id.
    const rels = await store.listRelations({ predicate: 'part-of' });
    expect(rels).toHaveLength(1);
    expect(rels[0]?.subject).toBe(job?.id);
    expect(rels[0]?.object).toBe(job?.id);
  });

  it('re-ingest merges aliases instead of duplicating entities', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'dossier.md'), '## Glossary\nx');
    writeFileSync(join(runDir, 'semantic.json'), JSON.stringify(SEMANTIC_JSON));
    await ingestSurveyArtifacts(runDir, store, {
      scope: 'product',
      name: 'myApp',
    });
    // Second survey: same concept under the alias as its primary name.
    writeFileSync(
      join(runDir, 'semantic.json'),
      JSON.stringify({
        entities: [{ name: 'SyncTask', kind: 'entity', aliases: ['ingest'] }],
        relations: [],
      }),
    );
    await ingestSurveyArtifacts(runDir, store, {
      scope: 'product',
      name: 'myApp',
    });
    const entities = await store.listEntities({ product: 'myApp' });
    const jobs = entities.filter(
      (e) =>
        e.canonical === 'IngestionJob' ||
        e.aliases.includes('SyncTask') ||
        e.canonical === 'SyncTask',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.aliases).toEqual(
      expect.arrayContaining(['SyncTask', 'ingest']),
    );
  });

  it('throws when dossier.md is missing or has no §11 sections', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runDir, { recursive: true });
    await expect(
      ingestSurveyArtifacts(runDir, store, {
        scope: 'repo',
        name: 'backend',
      }),
    ).rejects.toThrow();
    writeFileSync(join(runDir, 'dossier.md'), '## Appendix\nnothing');
    await expect(
      ingestSurveyArtifacts(runDir, store, {
        scope: 'repo',
        name: 'backend',
      }),
    ).rejects.toThrow(/no recognizable/);
  });
});

describe('mergeEntityAlias', () => {
  it('folds one entity into another and re-points relations', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'semantic.json'),
      JSON.stringify({
        entities: [
          { name: 'Jobs', kind: 'concept' },
          { name: 'Scheduler', kind: 'entity' },
        ],
        relations: [
          { subject: 'Scheduler', predicate: 'calls', object: 'Jobs' },
        ],
      }),
    );
    writeFileSync(join(runDir, 'dossier.md'), '## Glossary\nx');
    await ingestSurveyArtifacts(runDir, store, {
      scope: 'product',
      name: 'myApp',
    });
    const ents = await store.listEntities({ product: 'myApp' });
    const a = ents.find((e) => e.name === 'Jobs');
    const b = ents.find((e) => e.name === 'Scheduler');
    expect(a && b).toBeTruthy();
    await mergeEntityAlias(store, a?.id ?? '', b?.id ?? '');
    expect(await store.getEntity(a?.id ?? '')).toBeNull();
    const winner = await store.getEntity(b?.id ?? '');
    expect(winner?.aliases).toEqual(expect.arrayContaining(['Jobs']));
    // 'Scheduler calls Jobs' collapses to a self-edge → dropped.
    const rels = await store.listRelations({ predicate: 'calls' });
    expect(rels).toHaveLength(0);
    // The merge is recorded as a synonym-of edge.
    const syn = await store.listRelations({ predicate: 'synonym-of' });
    expect(syn).toHaveLength(1);
    expect(syn[0]?.object).toBe(b?.canonical);
  });
});
