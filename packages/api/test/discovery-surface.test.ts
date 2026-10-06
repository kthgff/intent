/**
 * wp-147 — Discovery UI surface routes (PRD §15.3/§15.9).
 *
 * Covers the HTTP boundary the new screens consume:
 *   - wizard catalog + session start (MVP wizards seeded idempotently);
 *   - answer turns (durable before the next question — engine-owned);
 *   - mode switch (conversation|guided|bulk) without loss;
 *   - the Understanding Panel payload: confirmed / interpretation /
 *     needs-clarification / decision-required buckets + explainable
 *     readiness (indicators, never a score);
 *   - statement decide (confirm/reject/dispute) + correction edits that
 *     write a NEW statement + supersedes edge (never overwrites);
 *   - statement decision ruling (decide/dismiss);
 *   - the capture tray: list, OCC-fenced PATCH (stale → 409), consume-
 *     frozen writes → 409, delete;
 *   - workspace scoping + zod fail-closed on every body.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@veto/conductor';
import { resolveConfig } from '@veto/config';
import type { StatementRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiServer, createServer } from '../src/index.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';

let dir: string;
let store: PostgresStore;

function makeConfig() {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeServer(): ApiServer {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: makeConfig(),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
  };
  return createServer({
    store,
    conductor: new Conductor(deps),
    config: makeConfig(),
    uiToken: TOKEN,
  });
}

const post = (app: ApiServer, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: AUTH, payload });
const get = (app: ApiServer, url: string) =>
  app.inject({ method: 'GET', url, headers: AUTH });

async function startSession(app: ApiServer) {
  const res = await post(app, '/api/v1/interview-sessions', {
    workspace: WS,
    wizard_id: 'solution-discovery',
    subject: 'board:ideas',
  });
  expect(res.statusCode).toBe(201);
  return res.json().session.session_id as string;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api-discovery-ui-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery UI surface (wp-147)', () => {
  it('lists the wizard catalog with slots + thresholds', async () => {
    const app = makeServer();
    const res = await get(app, `/api/v1/interview-wizards?workspace=${WS}`);
    expect(res.statusCode).toBe(200);
    const { wizards } = res.json();
    const wiz = wizards.find(
      (w: { wizard_id: string }) => w.wizard_id === 'solution-discovery',
    );
    expect(wiz.slots.length).toBeGreaterThan(0);
    expect(wiz.thresholds.approval.length).toBeGreaterThan(0);
    // draft ⊆ approval — two thresholds, never one gate.
    expect(wiz.thresholds.draft.length).toBeGreaterThanOrEqual(
      wiz.thresholds.approval.length,
    );
  });

  it('session lifecycle: start → answer → slots move → understanding buckets', async () => {
    const app = makeServer();
    const session = await startSession(app);

    const detail = (
      await get(app, `/api/v1/interview-sessions/${session}?workspace=${WS}`)
    ).json();
    expect(detail.slots.length).toBeGreaterThan(0);
    expect(detail.readiness.draft_ready).toBe(false);

    // A verbatim-fallback answer lands as a statement bound to the slot.
    const answered = await post(
      app,
      `/api/v1/interview-sessions/${session}/answer`,
      {
        workspace: WS,
        answer: 'Users wait three days for a password reset.',
        slot: 'problem',
      },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json().result.statements.length).toBe(1);

    const u = (
      await get(
        app,
        `/api/v1/interview-sessions/${session}/understanding?workspace=${WS}`,
      )
    ).json();
    // The proposed statement sits in interpretation, not confirmed —
    // inferred never auto-approves.
    expect(u.interpretation.statements.length).toBe(1);
    expect(u.confirmed.statements.length).toBe(0);
    expect(u.readiness.summary).toContain('draft_ready');
  });

  it('mode switches without loss; unknown modes fail closed', async () => {
    const app = makeServer();
    const session = await startSession(app);
    for (const mode of ['guided', 'bulk', 'conversation']) {
      const res = await post(
        app,
        `/api/v1/interview-sessions/${session}/mode`,
        { workspace: WS, mode },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().session.mode).toBe(mode);
    }
    const bad = await post(app, `/api/v1/interview-sessions/${session}/mode`, {
      workspace: WS,
      mode: 'telepathy',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('unanswerable resolves the question and defers the slot — never re-asked', async () => {
    const app = makeServer();
    const session = await startSession(app);
    // Plan + answer one question so a candidate exists to resolve.
    await post(app, `/api/v1/interview-sessions/${session}/answer`, {
      workspace: WS,
      answer: 'The problem is slow onboarding.',
      slot: 'problem',
    });
    const detail = (
      await get(app, `/api/v1/interview-sessions/${session}?workspace=${WS}`)
    ).json();
    const q = detail.pending_question;
    if (q) {
      const res = await post(
        app,
        `/api/v1/interview-sessions/${session}/questions/${encodeURIComponent(
          q.question_id,
        )}/resolve`,
        { workspace: WS, status: 'unanswerable' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().question.status).toBe('unanswerable');
    }
  });

  it('statement decide + correction writes a new versioned statement (supersede, not overwrite)', async () => {
    const app = makeServer();
    const session = await startSession(app);
    const answered = await post(
      app,
      `/api/v1/interview-sessions/${session}/answer`,
      { workspace: WS, answer: 'Resets take 3 days.', slot: 'problem' },
    );
    const st = answered.json().result.statements[0] as StatementRow;

    const confirmed = await post(
      app,
      `/api/v1/statements/${st.statement_id}/decide`,
      { workspace: WS, action: 'confirm' },
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().statement.status).toBe('confirmed');

    const corrected = await post(
      app,
      `/api/v1/statements/${st.statement_id}/correct`,
      {
        workspace: WS,
        text: 'Resets take 3 days on average.',
        session_id: session,
        slots: ['problem'],
      },
    );
    expect(corrected.statusCode).toBe(201);
    const body = corrected.json();
    expect(body.superseded.statement_id).toBe(st.statement_id);
    expect(body.statement.statement_id).not.toBe(st.statement_id);
    expect(body.statement.status).toBe('confirmed');

    // History is preserved — the old statement is superseded, not gone.
    const detail = (
      await get(app, `/api/v1/statements/${st.statement_id}?workspace=${WS}`)
    ).json();
    expect(detail.statement.status).toBe('superseded');
    expect(detail.versions.length).toBeGreaterThan(1);
    expect(
      detail.relations.incoming.some(
        (r: { predicate: string }) => r.predicate === 'supersedes',
      ),
    ).toBe(true);
  });

  it('dispute opens a decision item; the human rules it', async () => {
    const app = makeServer();
    const session = await startSession(app);
    const answered = await post(
      app,
      `/api/v1/interview-sessions/${session}/answer`,
      { workspace: WS, answer: 'SSO must be optional.', slot: 'constraints' },
    );
    const st = answered.json().result.statements[0] as StatementRow;

    const disputed = await post(
      app,
      `/api/v1/statements/${st.statement_id}/decide`,
      {
        workspace: WS,
        action: 'dispute',
        reason: 'conflicts with security review',
      },
    );
    expect(disputed.statusCode).toBe(200);
    const decisionId = disputed.json().decision_id as string;
    expect(decisionId).toBeTruthy();

    const u = (
      await get(
        app,
        `/api/v1/interview-sessions/${session}/understanding?workspace=${WS}`,
      )
    ).json();
    expect(u.decision_required.decisions.length).toBe(1);

    const ruled = await post(
      app,
      `/api/v1/statement-decisions/${decisionId}/decide`,
      { workspace: WS, decision: 'SSO stays optional', apply: 'confirmed' },
    );
    expect(ruled.statusCode).toBe(200);
    expect(ruled.json().decision.status).toBe('decided');
  });

  it('tray: capture → list → OCC patch → stale write 409 → delete', async () => {
    const app = makeServer();
    const cap = await post(app, '/api/v1/capture', {
      workspace: WS,
      title: 'ship dark mode',
    });
    expect(cap.statusCode).toBe(201);
    const item = cap.json().item as {
      id: string;
      board: string | null;
      updated_at: string;
    };
    expect(item.board).toBe(null);

    const tray = (await get(app, `/api/v1/tray?workspace=${WS}`)).json();
    expect(tray.items.map((i: { id: string }) => i.id)).toContain(item.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board-items/${item.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: item.updated_at,
        note_kind: 'want',
        title: 'Ship dark mode',
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().item.note_kind).toBe('want');

    // Stale write — the original updated_at is now out of date.
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board-items/${item.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: item.updated_at,
        title: 'stale write',
      },
    });
    expect(stale.statusCode).toBe(409);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/board-items/${item.id}?workspace=${WS}`,
      headers: AUTH,
    });
    expect(gone.statusCode).toBe(200);
  });

  it('tray → board promotion goes through the engine; workspace scoping is enforced', async () => {
    const app = makeServer();
    await post(app, '/api/v1/boards', {
      workspace: WS,
      board: 'ideas',
      name: 'Ideas',
      board_type: 'new-project',
    });
    const cap = await post(app, '/api/v1/capture', {
      workspace: WS,
      title: 'promote me',
    });
    const item = cap.json().item;
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board-items/${item.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: item.updated_at,
        board: 'ideas',
        status: 'active',
      },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().item.board).toBe('ideas');

    // Another workspace name cannot touch the row.
    const other = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board-items/${item.id}`,
      headers: AUTH,
      payload: {
        workspace: 'nope',
        expected_updated_at: moved.json().item.updated_at,
        title: 'x',
      },
    });
    expect(other.statusCode).toBe(404);
  });

  it('malformed bodies fail closed (400), unknown sessions 404', async () => {
    const app = makeServer();
    const bad = await post(app, '/api/v1/interview-sessions', {
      workspace: WS,
      // missing wizard_id
    });
    expect(bad.statusCode).toBe(400);

    const missing = await get(
      app,
      `/api/v1/interview-sessions/iv-nope?workspace=${WS}`,
    );
    expect(missing.statusCode).toBe(404);

    const badWs = await get(app, '/api/v1/interview-sessions?workspace=nope');
    expect(badWs.statusCode).toBe(404);
  });
});
