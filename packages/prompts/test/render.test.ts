import {
  type CapabilityFlags,
  PROMPT_TEMPLATES,
  PROMPT_TOKENS,
  STAGES,
  type TokenValues,
} from '@sprint-runner/core';
import { describe, expect, it } from 'vitest';
import {
  NO_EVIDENCE_TEXT,
  type RenderCtx,
  RenderError,
  STAGE_TEMPLATES,
  artifactTargets,
  capabilityNotes,
  dossierGateOk,
  dossierTokenValue,
  evidenceBundleTokenValue,
  renderEvidenceBundle,
  renderPrompt,
  renderTemplate,
  scanTokens,
  substitute,
} from '../src/index.js';

const RUN_ID = 'run-0001';
const RUN_DIR = '/abs/runs/run-0001';
const WORKTREE = '/abs/repo.worktrees/SR-0001';

const FULL_FLAGS: CapabilityFlags = {
  can_exec: true,
  can_write_outside_tree: true,
  has_gh: true,
};

const AIDER_FLAGS: CapabilityFlags = {
  can_exec: true,
  can_write_outside_tree: false,
  has_gh: false,
};

/** Maximal ctx fixture — a value for every token in the ADAPTERS table. */
function maximalCtx(flags: CapabilityFlags = FULL_FLAGS): RenderCtx {
  const tokens: TokenValues = {};
  for (const t of PROMPT_TOKENS) tokens[t] = `<${t}>`;
  // Computed tokens are still provided; renderer must override them.
  tokens.ARTIFACT_TARGETS = '<caller-artifact-targets>';
  tokens.CAPABILITY_NOTES = '<caller-capability-notes>';
  return { tokens, flags, runId: RUN_ID, runDir: RUN_DIR, worktree: WORKTREE };
}

describe('render every shipped template', () => {
  for (const name of Object.keys(PROMPT_TEMPLATES)) {
    it(`renders '${name}' with no unresolved tokens`, () => {
      const r = renderTemplate(name, maximalCtx());
      expect(r.text).not.toMatch(/\{\{/);
      expect(r.template).toBe(name);
      expect(Object.keys(r.tokens).length).toBeGreaterThan(0);
    });
  }

  it('renders every stage that has a template via renderPrompt', () => {
    for (const stage of STAGES) {
      if (STAGE_TEMPLATES[stage] === null) continue;
      const r = renderPrompt(stage, maximalCtx());
      expect(r.text).not.toMatch(/\{\{/);
    }
  });

  it('review maps to review-base; verify has no prompt', () => {
    expect(renderPrompt('review', maximalCtx()).template).toBe('review-base');
    expect(() => renderPrompt('verify', maximalCtx())).toThrow(RenderError);
    expect(() => renderPrompt('verify', maximalCtx())).toThrow(/verify/);
  });
});

describe('missing token → named error', () => {
  it('throws RenderError naming token + stage + template', () => {
    const ctx = maximalCtx();
    const tokens = { ...(ctx.tokens ?? {}) };
    tokens.TICKET_ID = undefined;
    ctx.tokens = tokens;
    let err: unknown;
    try {
      renderPrompt('triage', ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RenderError);
    const re = err as RenderError;
    expect(re.token).toBe('TICKET_ID');
    expect(re.stage).toBe('triage');
    expect(re.template).toBe('triage');
    expect(re.message).toContain('TICKET_ID');
    expect(re.message).toContain('triage');
  });

  it('errors on tokens not in the ADAPTERS token table', () => {
    const { unresolved } = substitute('x {{BOGUS_TOKEN}} y', () => undefined);
    expect(unresolved).toEqual(['BOGUS_TOKEN']);
    // …and renderTemplate fails closed on it (fixture resolves knowns only)
    const ctx = maximalCtx();
    const tokens = { ...(ctx.tokens ?? {}) };
    tokens.TICKET_MD = undefined;
    ctx.tokens = tokens;
    expect(() => renderTemplate('triage', ctx)).toThrow(/TICKET_MD/);
  });
});

describe('capability matrix (ADAPTERS)', () => {
  it('aider flags → worktree-relative scratch paths', () => {
    const r = renderPrompt('implement', maximalCtx(AIDER_FLAGS));
    expect(r.text).toContain(`.sprint-runner/${RUN_ID}/`);
    expect(r.text).not.toContain(RUN_DIR);
    expect(r.text).toContain('runner collects');
  });

  it('devin flags → absolute runDir paths, no capability notes', () => {
    const r = renderPrompt('implement', maximalCtx(FULL_FLAGS));
    expect(r.text).toContain(`${RUN_DIR}/`);
    expect(r.text).not.toContain('.sprint-runner/');
    expect(capabilityNotes(FULL_FLAGS)).toBe('');
  });

  it('artifactTargets switches on can_write_outside_tree', () => {
    expect(artifactTargets(FULL_FLAGS, RUN_ID, RUN_DIR)).toContain(RUN_DIR);
    expect(artifactTargets(AIDER_FLAGS, RUN_ID, RUN_DIR)).toContain(
      `.sprint-runner/${RUN_ID}/`,
    );
  });

  it('capabilityNotes covers each missing capability', () => {
    const notes = capabilityNotes({
      can_exec: false,
      can_write_outside_tree: false,
      has_gh: false,
    });
    expect(notes).toContain('cannot run shell commands');
    expect(notes).toContain('cannot write outside the repo tree');
    expect(notes).toContain('cannot run `gh`');
    expect(notes).toContain('runner');
  });
});

describe('token mechanics', () => {
  it('matches {{TOKEN}} and {{ TOKEN }} whitespace-tolerantly', () => {
    const { text, resolved } = substitute(
      'a {{ TICKET_ID }} b {{TICKET_ID}} c {{  DEPTH\t}}',
      (t) => `<${t}>`,
    );
    expect(text).toBe('a <TICKET_ID> b <TICKET_ID> c <DEPTH>');
    expect(resolved.sort()).toEqual(['DEPTH', 'TICKET_ID']);
  });

  it('scanTokens reports unique names in first-use order', () => {
    expect(scanTokens('{{A}} {{ B }} {{A}} {{C_D}}')).toEqual([
      'A',
      'B',
      'C_D',
    ]);
  });

  it('is deterministic — same ctx, same bytes', () => {
    const a = renderPrompt('design', maximalCtx(AIDER_FLAGS));
    const b = renderPrompt('design', maximalCtx(AIDER_FLAGS));
    expect(a.text).toBe(b.text);
  });

  it('single-pass — replacement text is never re-scanned', () => {
    const { text } = substitute('{{A}}', (t) => (t === 'A' ? '{{B}}' : 'x'));
    expect(text).toBe('{{B}}');
  });
});

describe('dossier gate (CONDUCTOR dossier wait)', () => {
  it('light/standard proceed regardless; deep parks until surveyed', () => {
    expect(dossierGateOk('light', false)).toBe(true);
    expect(dossierGateOk('standard', false)).toBe(true);
    expect(dossierGateOk('deep', false)).toBe(false);
    expect(dossierGateOk('deep', true)).toBe(true);
  });

  it('dossierTokenValue injects "dossier pending" when unsurveyed', () => {
    expect(dossierTokenValue(undefined)).toBe('dossier pending');
    expect(dossierTokenValue('real dossier')).toBe('real dossier');
  });
});

describe('EVIDENCE_BUNDLE (D37, wp-110)', () => {
  const VALID_BUNDLE = {
    schema: 1,
    request: {
      workspace: 'team-a',
      task: 'implement',
      query: 'savePreferences',
      repos: ['api'],
      source_types: ['code'],
      commit_policy: 'current',
      limit: 20,
      token_limit: 8000,
    },
    index_heads: [{ repo: 'api', commit_sha: 'deadbeefcafe' }],
    results: [
      {
        evidence_id: 'ev_1',
        source_type: 'code',
        object_ref: 'code:api:deadbeefcafe:src/prefs.ts:savePreferences',
        repo: 'api',
        commit_sha: 'deadbeefcafe',
        path: 'src/prefs.ts',
        start_line: 3,
        end_line: 6,
        symbol: 'savePreferences',
        content_hash: 'sha256:abc',
        excerpt: 'export function savePreferences() {}',
        freshness: 'current',
        scores: { exact: 1, final: 1 },
        why: ['exact-symbol'],
      },
    ],
    zero_result_reason: null,
    generated_at: '2026-10-05T00:00:00Z',
  };

  it('empty/missing token value renders the explicit no-evidence block', () => {
    expect(evidenceBundleTokenValue(undefined)).toBe(NO_EVIDENCE_TEXT);
    expect(evidenceBundleTokenValue('')).toBe(NO_EVIDENCE_TEXT);
    expect(evidenceBundleTokenValue('   ')).toBe(NO_EVIDENCE_TEXT);
    expect(evidenceBundleTokenValue('<bundle>')).toBe('<bundle>');
  });

  it('code-aware templates never render the token as a silent empty', () => {
    // Caller supplied '' — the renderer substitutes the explicit block.
    const ctx = maximalCtx();
    ctx.tokens = { ...(ctx.tokens ?? {}), EVIDENCE_BUNDLE: '' };
    const r = renderPrompt('implement', ctx);
    expect(r.text).toContain('No relevant evidence');
    for (const stage of ['prd', 'design', 'testplan', 'review'] as const) {
      const out = renderPrompt(stage, maximalCtx());
      expect(out.text).not.toMatch(/\{\{/);
      // The maximal ctx supplies a caller value — it flows through.
      expect(out.text).toContain('<EVIDENCE_BUNDLE>');
    }
  });

  it('renderEvidenceBundle formats a valid cited bundle', () => {
    const text = renderEvidenceBundle(VALID_BUNDLE);
    expect(text).toContain('ev_1');
    expect(text).toContain('src/prefs.ts:3-6');
    expect(text).toContain('savePreferences');
    expect(text).toContain('api@deadbee');
    expect(text).toContain('exact-symbol');
  });

  it('renders the explicit zero-result artifact with its reason', () => {
    const text = renderEvidenceBundle({
      ...VALID_BUNDLE,
      results: [],
      zero_result_reason: 'no evidence matched the query',
    });
    expect(text).toContain('No relevant evidence');
    expect(text).toContain('no evidence matched the query');
  });

  it('fails closed on malformed or uncited code results', () => {
    const bad = {
      ...VALID_BUNDLE,
      results: [{ ...VALID_BUNDLE.results[0], content_hash: null }],
    };
    expect(() => renderEvidenceBundle(bad)).toThrow(/content_hash|validation/);
    expect(() => renderEvidenceBundle({ schema: 1 })).toThrow();
  });
});
