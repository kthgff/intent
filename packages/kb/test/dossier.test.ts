import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '@sprint-runner/core';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dossierToken,
  editDossierSection,
  parseDossierMarkdown,
  surveySubject,
  surveyTokens,
  writeDossierSection,
} from '../src/index.js';

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-kb-'));
  store = new SqliteStore(`sqlite://${join(dir, 'state.db')}`);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  scope: 'repo' as const,
  name: 'backend',
  section: 'glossary' as const,
  surveyed_at: '2026-10-04T00:00:00Z',
  sources_used: ['code' as const],
};

describe('dossier versioning (DB-SCHEMA rules via real store)', () => {
  it('re-survey writes version+1', async () => {
    await writeDossierSection(store, { ...base, content: 'v1 body' });
    await writeDossierSection(store, {
      ...base,
      content: 'v2 body',
      surveyed_at: '2026-10-05T00:00:00Z',
    });
    const versions = await store.listDossierVersions(
      'repo',
      'backend',
      'glossary',
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(
      (await store.getDossierSection('repo', 'backend', 'glossary'))?.content,
    ).toBe('v2 body');
  });

  it('unchanged-but-older sibling sections flagged stale on refresh', async () => {
    await writeDossierSection(store, { ...base, content: 'old glossary' });
    await writeDossierSection(store, {
      ...base,
      section: 'landmines',
      content: 'old landmines',
    });
    // Refresh only the glossary at a later surveyed_at.
    await writeDossierSection(store, {
      ...base,
      content: 'fresh glossary',
      surveyed_at: '2026-10-06T00:00:00Z',
    });
    const landmines = await store.getDossierSection(
      'repo',
      'backend',
      'landmines',
    );
    expect(landmines?.stale).toBe(true);
    const glossary = await store.getDossierSection(
      'repo',
      'backend',
      'glossary',
    );
    expect(glossary?.stale).toBe(false);
  });

  it('human edit wins over a later machine refresh', async () => {
    await writeDossierSection(store, { ...base, content: 'agent v1' });
    await editDossierSection(store, {
      ...base,
      content: 'human correction',
      actor: 'keith',
      at: '2026-10-05T12:00:00Z',
    });
    const human = await store.getDossierSection('repo', 'backend', 'glossary');
    expect(human?.content).toBe('human correction');
    expect(human?.edited_by).toBe('keith');
    // Machine re-survey arrives — new row is flagged stale, human row intact.
    await writeDossierSection(store, {
      ...base,
      content: 'agent v3 overwrite attempt',
      surveyed_at: '2026-10-06T00:00:00Z',
    });
    const versions = await store.listDossierVersions(
      'repo',
      'backend',
      'glossary',
    );
    expect(versions).toHaveLength(3);
    const latest = versions[2];
    expect(latest?.stale).toBe(true);
    const v2 = await store.getDossierSection('repo', 'backend', 'glossary', 2);
    expect(v2?.content).toBe('human correction');
    expect(v2?.edited_by).toBe('keith');
  });
});

describe('surveySubject + surveyTokens', () => {
  it('builds the subject string and token values', async () => {
    expect(surveySubject('product', 'myApp')).toBe('survey:product:myApp');
    const config = ConfigSchema.parse({
      schema: 1,
      survey: { budget_usd: 12.5, sources: ['code', 'docs', 'tickets'] },
      products: {
        myApp: {
          repos: ['backend', 'frontend'],
          docs: ['/docs/manuals'],
          screenshots: '/shots',
          app_url: 'http://localhost:3000',
        },
      },
    });
    const t = await surveyTokens({
      config,
      scope: 'product',
      name: 'myApp',
      runDir: '/tmp/run/001-survey',
      store,
    });
    expect(t.subject).toBe('survey:product:myApp');
    expect(t.SCOPE).toBe('product');
    expect(t.SCOPE_NAME).toBe('myApp');
    expect(t.REPO_NAMES).toBe('backend, frontend');
    expect(t.SURVEY_BUDGET).toBe('$12.50');
    expect(t.APP_URL).toBe('http://localhost:3000');
    expect(t.DOC_PATHS).toBe('/docs/manuals');
    expect(t.SCREENSHOT_DIR).toBe('/shots');
    expect(t.EXTRA_SOURCES).toBe('tickets');
    expect(t.PRIOR_DOSSIER).toBe('none — first survey');
    expect(t.SEMANTIC_OUT).toBe('/tmp/run/001-survey/semantic.json');
    expect(t.DOSSIER_OUT).toBe('/tmp/run/001-survey/dossier.md');
  });

  it('uncapped budget and repo scope', async () => {
    const config = ConfigSchema.parse({ schema: 1 });
    const t = await surveyTokens({
      config,
      scope: 'repo',
      name: 'backend',
      runDir: '/tmp/r',
      store,
    });
    expect(t.SURVEY_BUDGET).toBe('uncapped');
    expect(t.REPO_NAMES).toBe('backend');
    expect(t.APP_URL).toBe('not provided — no crawl');
  });
});

describe('parseDossierMarkdown + dossierToken', () => {
  it('maps ## headings to §11 slugs and reports unknown headings', () => {
    const md = [
      '# Dossier — backend',
      'intro junk',
      '## Architecture map',
      'modules here',
      '## Glossary',
      'term = def',
      '## Random appendix',
      'kept out',
    ].join('\n');
    const { sections, unmatchedHeadings } = parseDossierMarkdown(md);
    expect(sections.get('architecture-map')).toBe('modules here');
    expect(sections.get('glossary')).toBe('term = def');
    expect(unmatchedHeadings).toEqual(['Random appendix']);
  });

  it('dossierToken renders sections, scoped or full; pending when empty', async () => {
    expect(await dossierToken(store, 'repo', 'backend')).toBe(
      'dossier pending',
    );
    await writeDossierSection(store, { ...base, content: 'term = def' });
    await writeDossierSection(store, {
      ...base,
      section: 'landmines',
      content: 'fragile zone',
    });
    const scoped = await dossierToken(store, 'repo', 'backend', {
      sections: ['glossary'],
    });
    expect(scoped).toContain('## Glossary');
    expect(scoped).toContain('term = def');
    expect(scoped).not.toContain('fragile zone');
    const scopedEmpty = await dossierToken(store, 'repo', 'backend', {
      sections: ['ui-map'],
    });
    expect(scopedEmpty).toBe('dossier pending');
  });
});
