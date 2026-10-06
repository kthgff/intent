/**
 * Dossiers (SCHEMAS §11, DB-SCHEMA dossiers rules) — survey-run
 * machinery: subject naming, survey-prompt token values, artifact
 * ingest, human edit, and the {{DOSSIER}} token body.
 *
 * Versioning/stale/edited_by semantics live in the Store
 * (packages/store implements DB-SCHEMA: every write = MAX(version)+1,
 * unchanged-but-older siblings flagged stale, human `edited_by`
 * survives re-survey flagged for review). This module owns the
 * section-name mapping (markdown `## Heading` ⇄ §11 slugs) and the
 * fail-closed parse of survey artifacts.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Config,
  DOSSIER_SECTIONS,
  type DossierEntry,
  type DossierScope,
  type DossierSection,
  type DossierSource,
  EntitySchema,
  RelationSchema,
  type Store,
  type TokenValues,
} from '@veto/core';
import { z } from 'zod';
import { norm, upsertEntity } from './entities.js';

/** `## Heading` text for each §11 section slug (survey.md's output). */
export const SECTION_HEADINGS: Record<DossierSection, string> = {
  'architecture-map': 'Architecture map',
  'domain-model': 'Domain model',
  'user-workflows': 'User workflows',
  personas: 'Personas',
  'docs-digest': 'Docs digest',
  'ui-map': 'UI map',
  glossary: 'Glossary',
  landmines: 'Landmines',
  'gap-report': 'Gap report',
};

const HEADING_TO_SECTION = new Map<string, DossierSection>(
  DOSSIER_SECTIONS.map((s) => [s, s]),
);

const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Coordination subject for a survey run (DB-SCHEMA subject rules). */
export function surveySubject(scope: DossierScope, name: string): string {
  return `survey:${scope}:${name}`;
}

// ---------- survey prompt tokens ----------

export interface SurveyTokensOpts {
  /** Effective config (survey:, products:, repos: blocks). */
  config: Pick<Config, 'survey' | 'products' | 'repos'>;
  scope: DossierScope;
  name: string;
  /** Run artifact dir — SEMANTIC_OUT/DOSSIER_OUT point inside it. */
  runDir: string;
  /** For PRIOR_DOSSIER (incremental refresh context). */
  store: Store;
}

/** Filenames the survey agent writes inside `runDir`. */
export const SURVEY_ARTIFACTS = {
  dossier: 'dossier.md',
  semantic: 'semantic.json',
} as const;

/** Render the prior dossier for the PRIOR_DOSSIER token ('' → 'none'). */
export function renderDossier(sections: DossierEntry[]): string {
  return sections
    .map(
      (s) =>
        `## ${SECTION_HEADINGS[s.section as DossierSection] ?? s.section}\n${s.content}${s.stale ? '\n\n_(flagged stale — pending review)_' : ''}`,
    )
    .join('\n\n');
}

/**
 * Token values for docs/prompts/survey.md. Caller adds ARTIFACT_TARGETS
 * (renderer-computed) — this provides every survey-specific token.
 */
export async function surveyTokens(
  opts: SurveyTokensOpts,
): Promise<TokenValues & { subject: string }> {
  const { config, scope, name, runDir, store } = opts;
  const product = scope === 'product' ? config.products[name] : undefined;
  const repoNames = scope === 'product' ? (product?.repos ?? []) : [name];
  const standardSources = new Set(['code', 'docs', 'screenshots', 'crawl']);
  const extra = (config.survey.sources ?? []).filter(
    (s) => !standardSources.has(s),
  );
  const prior = await store.getDossier(scope, name);
  return {
    subject: surveySubject(scope, name),
    SCOPE: scope,
    SCOPE_NAME: name,
    REPO_NAMES: repoNames.length ? repoNames.join(', ') : 'none',
    SURVEY_BUDGET:
      config.survey.budget_usd == null
        ? 'uncapped'
        : `$${config.survey.budget_usd.toFixed(2)}`,
    DOC_PATHS: product?.docs.length ? product.docs.join('\n') : 'none provided',
    SCREENSHOT_DIR: product?.screenshots ?? 'none provided',
    APP_URL: product?.app_url ?? 'not provided — no crawl',
    EXTRA_SOURCES: extra.length ? extra.join(', ') : 'none',
    PRIOR_DOSSIER: prior.length ? renderDossier(prior) : 'none — first survey',
    SEMANTIC_OUT: join(runDir, SURVEY_ARTIFACTS.semantic),
    DOSSIER_OUT: join(runDir, SURVEY_ARTIFACTS.dossier),
  };
}

// ---------- writes ----------

/** Write one dossier section (machine survey output). Version + stale
 *  handling is the store's; callers pass `edited_by` ONLY for human
 *  edits so edit-wins semantics engage. */
export async function writeDossierSection(
  store: Store,
  entry: Omit<DossierEntry, 'version' | 'stale'> & { stale?: boolean },
): Promise<void> {
  await store.upsertDossierSection({
    ...entry,
    version: 0,
    stale: entry.stale ?? false,
  });
}

/** Human correction from the KB screen — `edited_by` set so a later
 *  machine refresh can't silently overwrite (DB-SCHEMA rules). */
export async function editDossierSection(
  store: Store,
  e: {
    scope: DossierScope;
    name: string;
    section: DossierSection;
    content: string;
    actor: string;
    at?: string;
  },
): Promise<void> {
  const prior = await store.getDossierSection(e.scope, e.name, e.section);
  const at = e.at ?? new Date().toISOString();
  await store.upsertDossierSection({
    scope: e.scope,
    name: e.name,
    section: e.section,
    version: 0,
    content: e.content,
    surveyed_at: prior?.surveyed_at ?? at,
    sources_used: prior?.sources_used ?? [],
    stale: false,
    edited_by: e.actor,
    edited_at: at,
  });
}

// ---------- survey artifact ingest ----------

/** Lenient agent-output row → full Entity (defaults applied; `id`
 *  assigned by {@link entityId} inside upsertEntity). */
const SemanticEntityIn = EntitySchema.omit({ id: true, product: true })
  .partial({ kind: true, canonical: true, source: true })
  .extend({ id: z.string().optional() });
const SemanticFile = z.object({
  entities: z.array(SemanticEntityIn).default([]),
  relations: z.array(RelationSchema).default([]),
});

export interface IngestResult {
  sections: DossierSection[];
  entities: number;
  relations: number;
  /** `## Heading`s that didn't map to a §11 section (kept, not fatal). */
  unmatchedHeadings: string[];
}

/** Parse `## Section` markdown into §11 section bodies. */
export function parseDossierMarkdown(md: string): {
  sections: Map<DossierSection, string>;
  unmatchedHeadings: string[];
} {
  const sections = new Map<DossierSection, string>();
  const unmatchedHeadings: string[] = [];
  let current: { section: DossierSection | null; buf: string[] } = {
    section: null,
    buf: [],
  };
  const flush = () => {
    if (current.section) {
      const body = current.buf.join('\n').trim();
      const prev = sections.get(current.section);
      sections.set(current.section, prev ? `${prev}\n\n${body}` : body);
    }
  };
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      const s = HEADING_TO_SECTION.get(slug(h[1] ?? ''));
      if (s) current = { section: s, buf: [] };
      else {
        unmatchedHeadings.push((h[1] ?? '').trim());
        current = { section: null, buf: [] };
      }
    } else if (current.section) {
      current.buf.push(line);
    }
  }
  flush();
  return { sections, unmatchedHeadings };
}

/**
 * Ingest a survey run's artifacts: `<runDir>/dossier.md` → section rows
 * (version+1 each; edit-wins + stale-flagging via the store), and
 * `<runDir>/semantic.json` → entities (alias-merged) + relations.
 * Fail-closed: missing dossier.md or malformed semantic.json throws.
 */
export async function ingestSurveyArtifacts(
  runDir: string,
  store: Store,
  opts: {
    scope: DossierScope;
    name: string;
    surveyedAt?: string;
    sources?: DossierSource[];
    /** entities.product — defaults to the dossier `name`. */
    product?: string;
  },
): Promise<IngestResult> {
  const surveyedAt = opts.surveyedAt ?? new Date().toISOString();
  const sources = opts.sources ?? ['code', 'docs'];
  const product = opts.product ?? opts.name;

  const md = await readFile(join(runDir, SURVEY_ARTIFACTS.dossier), 'utf8');
  const { sections, unmatchedHeadings } = parseDossierMarkdown(md);
  if (sections.size === 0) {
    throw new Error(
      `survey dossier at ${runDir}/${SURVEY_ARTIFACTS.dossier} has no recognizable §11 sections — malformed output blocks the pipeline`,
    );
  }
  for (const [section, content] of sections) {
    await store.upsertDossierSection({
      scope: opts.scope,
      name: opts.name,
      section,
      version: 0,
      content,
      surveyed_at: surveyedAt,
      sources_used: sources,
      stale: false,
      edited_by: null,
      edited_at: null,
    });
  }

  let entities = 0;
  let relations = 0;
  try {
    const raw = await readFile(join(runDir, SURVEY_ARTIFACTS.semantic), 'utf8');
    const parsed = SemanticFile.parse(JSON.parse(raw));
    const idByName = new Map<string, string>();
    for (const e of parsed.entities) {
      const canonical = e.canonical ?? e.name;
      const id = await upsertEntity(store, {
        id: e.id ?? '',
        product,
        kind: e.kind ?? 'concept',
        name: e.name,
        canonical,
        aliases: e.aliases,
        source: e.source ?? 'inferred',
        evidence: e.evidence,
      });
      for (const term of [e.name, canonical, ...e.aliases]) {
        idByName.set(norm(term), id);
      }
      entities += 1;
    }
    for (const r of parsed.relations) {
      // Relation endpoints may name entities by any alias — resolve.
      const resolve = (t: string) => idByName.get(norm(t)) ?? t;
      await store.upsertRelation({
        ...r,
        subject: resolve(r.subject),
        object: resolve(r.object),
      });
      relations += 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // semantic.json absent → dossier-only ingest (allowed).
  }
  return {
    sections: [...sections.keys()],
    entities,
    relations,
    unmatchedHeadings,
  };
}

// ---------- {{DOSSIER}} ----------

/**
 * {{DOSSIER}} token body: SCOPED sections matched to the ticket's
 * touched area (§11 consumption rule — never the whole dossier). When
 * `sections` is empty/absent, injects everything surveyed (small
 * scopes) — callers scope by passing the touched sections.
 * Unsurveyed → 'dossier pending' (prompts.dossierGateOk decides
 * whether a deep ticket parks; this only produces the token value).
 */
export async function dossierToken(
  store: Store,
  scope: DossierScope,
  name: string,
  opts: { sections?: DossierSection[] } = {},
): Promise<string> {
  const all = await store.getDossier(scope, name);
  if (all.length === 0) return 'dossier pending';
  const wanted = opts.sections?.length ? new Set(opts.sections) : null;
  const picked = all.filter(
    (s) => !wanted || wanted.has(s.section as DossierSection),
  );
  if (picked.length === 0) return 'dossier pending';
  return renderDossier(picked);
}
