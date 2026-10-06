/**
 * wp-120 — telemetry + incident intelligence (D37 Phase C, SCHEMAS
 * §19, INTELLIGENCE §6).
 *
 * Driven directly against PostgresStore (pglite) — the same harness as
 * wp-112. Covers: sanitization (secrets/PII/request bodies never
 * persist; identity attrs survive), fingerprint cluster precision on
 * deceptively similar failures, dedupe count aggregation (no
 * per-event rows), incident open/dedupe/recurrence, deterministic
 * investigation (hypotheses + disconfirming refs + verified similar
 * incidents), validated resolution (evidence required; OCC + audit),
 * the draft-ticket gate (no scope before human approve), and
 * retention.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploymentRow, ReleaseRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TelemetryServiceError,
  decideDraftTicket,
  decideIncidentStatus,
  fingerprintEvent,
  ingestTelemetry,
  investigateIncident,
  proposeDraftTicket,
  registerTelemetrySource,
  sanitizeTelemetryEvent,
  secretConfigIssues,
} from '../src/telemetry/index.js';

const WS = 'ws-a';
const NOW = '2026-10-06T00:00:00Z';

let dir: string;
let store: PostgresStore;

const ctx = (workspace = WS) => ({
  store,
  workspace,
  actor: 'test-bot',
  now: () => new Date(NOW),
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp120-'));
  store = await PostgresStore.connect('pglite:');
  await store.upsertProject({ workspace: WS, created_at: NOW });
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedSource(id = 'otel-prod') {
  return registerTelemetrySource(ctx(), {
    id,
    kind: 'otlp',
    config: { endpoint: 'https://otel.example.com', token: 'env:OTEL_TOKEN' },
  });
}

const evt = (over: Record<string, unknown> = {}) => ({
  message: 'NullPointerException in checkout handler for user 42',
  exception_class: 'NullPointerException',
  error_code: 'NPE-1001',
  stack: ['com.app.Checkout.handle(Checkout.java:42)'],
  attributes: {
    service: 'payments',
    version: '1.4.0',
    deployment: 'dep_1',
    trace_id: 'abc-trace',
    request_body: '{"card":"4111 1111 1111 1111"}',
    authorization: 'Bearer sk-live-secret-token',
    email: 'jane@example.com',
  },
  timestamp: '2026-10-05T10:00:00Z',
  ...over,
});

// ---------------------------------------------------------------------------

describe('source registration (authorization + secret hygiene)', () => {
  it('registers a source; rejects raw secret values and unknown kinds', async () => {
    const src = await seedSource();
    expect(src.enabled).toBe(1);
    expect(src.redaction_policy).toBe('telemetry-redaction-v1');
    await expect(
      registerTelemetrySource(ctx(), {
        id: 'bad',
        kind: 'otlp',
        config: { api_token: 'sk-live-literal-value' },
      }),
    ).rejects.toThrow(TelemetryServiceError);
    await expect(
      registerTelemetrySource(ctx(), { id: 'bad2', kind: 'splunk' }),
    ).rejects.toThrow(/unknown telemetry source kind/);
    expect(secretConfigIssues({ token: 'env:X' })).toEqual([]);
    expect(secretConfigIssues({ password: 'hunter2' })).toHaveLength(1);
  });

  it('refuses ingest for unknown or disabled sources', async () => {
    await expect(
      ingestTelemetry(ctx(), { source_id: 'nope', events: [evt()] }),
    ).rejects.toThrow(/no telemetry source/);
    await seedSource('disabled-src');
    await store.upsertTelemetrySource({
      id: 'disabled-src',
      workspace: WS,
      kind: 'otlp',
      config: {},
      redaction_policy: null,
      enabled: 0,
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(
      ingestTelemetry(ctx(), {
        source_id: 'disabled-src',
        events: [evt()],
      }),
    ).rejects.toThrow(/disabled/);
  });
});

describe('sanitization + fingerprint', () => {
  it('redacts secrets/PII/request bodies but preserves identity', () => {
    const s = sanitizeTelemetryEvent(evt());
    const blob = JSON.stringify(s);
    expect(blob).not.toContain('sk-live-secret-token');
    expect(blob).not.toContain('jane@example.com');
    expect(blob).not.toContain('4111');
    expect(s.attributes.request_body).toBe('<redacted:body>');
    // Identity preserved for clustering/attribution.
    expect(s.attributes.service).toBe('payments');
    expect(s.attributes.version).toBe('1.4.0');
    expect(s.exception_class).toBe('NullPointerException');
    expect(s.error_code).toBe('NPE-1001');
    expect(s.frames[0]).toContain('Checkout.handle');
  });

  it('clusters variable values; separates deceptive near-duplicates', () => {
    const a = sanitizeTelemetryEvent(evt());
    const b = sanitizeTelemetryEvent(
      evt({ message: 'NullPointerException in checkout handler for user 99' }),
    );
    expect(fingerprintEvent(a)).toBe(fingerprintEvent(b));
    // Same message text but a DIFFERENT service → different cluster.
    const other = sanitizeTelemetryEvent(
      evt({
        attributes: { ...evt().attributes, service: 'billing' },
      }),
    );
    expect(fingerprintEvent(other)).not.toBe(fingerprintEvent(a));
  });

  it('fails closed on unclassifiable events', () => {
    expect(() => sanitizeTelemetryEvent({})).toThrow(/fail-closed|refused/);
  });
});

describe('ingest — dedupe + incident lifecycle', () => {
  it('one signature row per pattern; repeated events only bump count', async () => {
    await seedSource();
    const r1 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [
        evt(),
        evt(),
        evt({
          message: 'NullPointerException in checkout handler for user 77',
        }),
      ],
    });
    expect(r1.signatures).toHaveLength(1);
    expect(r1.signatures.at(0).count).toBe(3);
    // New signature → one incident opened.
    expect(r1.incidents_opened).toHaveLength(1);
    expect(r1.incidents_opened.at(0).id).toMatch(/^INC-/);

    const r2 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt(), evt()],
    });
    expect(r2.signatures).toHaveLength(1);
    expect(r2.signatures.at(0).count).toBe(5); // aggregated, not re-rowed
    // Live incident absorbs repeats — no duplicate investigation.
    expect(r2.incidents_opened).toHaveLength(0);
    const sigs = await store.listErrorSignatures({ workspace: WS });
    expect(sigs).toHaveLength(1);
  });

  it('recurrence after resolution opens a new incident', async () => {
    await seedSource();
    const r1 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const inc = r1.incidents_opened.at(0);
    await decideIncidentStatus(ctx(), {
      id: inc.id,
      action: 'resolve',
      expected: 'open',
      evidence: { resolution: 'fix shipped', deployment_refs: ['dep_9'] },
    });
    const r2 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    expect(r2.incidents_opened).toHaveLength(1);
    expect(r2.incidents_opened.at(0).id).not.toBe(inc.id);
    expect(r2.incidents_opened.at(0).summary).toContain('recurrence');
  });
});

describe('investigation (SCHEMAS §19)', () => {
  it('ranks the deployment hypothesis with disconfirming refs + similar incidents', async () => {
    await seedSource();
    const release: ReleaseRow = {
      workspace: WS,
      release_id: 'REL-0001',
      title: 'train',
      status: 'released',
      target: null,
      created_by: 'ops',
      created_at: '2026-10-05T08:00:00Z',
      updated_at: '2026-10-05T08:00:00Z',
    };
    await store.upsertRelease(release);
    const dep: DeploymentRow = {
      workspace: WS,
      deployment_id: 'dep_1',
      release_id: 'REL-0001',
      environment: 'prod',
      sha: 'd'.repeat(40),
      evidence: { type: 'manual', by: 'ops', note: 'shipped' },
      confirmed_by: 'ops',
      confirmed_at: '2026-10-05T09:00:00Z',
      created_at: '2026-10-05T09:00:00Z',
    };
    await store.insertDeployment(dep);
    // A deployment AFTER the window — disconfirming.
    await store.insertDeployment({
      ...dep,
      deployment_id: 'dep_2',
      confirmed_at: '2026-10-05T11:30:00Z',
      created_at: '2026-10-05T11:30:00Z',
    });

    const r1 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const inc1 = r1.incidents_opened.at(0);
    // Resolve the first incident as verified knowledge.
    await decideIncidentStatus(ctx(), {
      id: inc1.id,
      action: 'resolve',
      expected: 'open',
      evidence: { resolution: 'rolled back', deployment_refs: ['dep_1'] },
    });
    const r2 = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const inc2 = r2.incidents_opened.at(0);

    const { artifact, ref } = await investigateIncident(ctx(), inc2.id);
    expect(ref).toContain('incident-investigation.json');
    expect(artifact.observed.count).toBe(2);
    expect(artifact.observed.deployments).toContain('dep_1');
    expect(artifact.hypotheses.at(0).summary).toContain('dep_1');
    expect(artifact.hypotheses.at(0).disconfirming_refs).toContain(
      'deployment:dep_2',
    );
    expect(artifact.similar_incidents).toEqual([
      { incident: inc1.id, resolution_verified: true },
    ]);
    expect(artifact.sanitization_policy).toBe('telemetry-redaction-v1');
    const updated = await store.getIncident({ workspace: WS, id: inc2.id });
    expect(updated?.investigation_ref).toBe(ref);
  });
});

describe('validated resolution + decide lifecycle', () => {
  it('resolve requires evidence; OCC + audit + reopen semantics hold', async () => {
    await seedSource();
    const r = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const inc = r.incidents_opened.at(0);

    // AI assertion alone can never resolve — evidence required.
    await expect(
      decideIncidentStatus(ctx(), {
        id: inc.id,
        action: 'resolve',
        expected: 'open',
      }),
    ).rejects.toThrow(/evidence/);

    const moved = await decideIncidentStatus(ctx(), {
      id: inc.id,
      action: 'investigate',
      expected: 'open',
      rationale: 'on it',
    });
    expect(moved.status).toBe('investigating');

    const resolved = await decideIncidentStatus(ctx(), {
      id: inc.id,
      action: 'resolve',
      expected: 'investigating',
      evidence: {
        resolution: 'fix deployed',
        deployment_refs: ['dep_7'],
        root_cause: 'null guard missing',
      },
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution_verified).toBe(1);
    expect(resolved.deployment_refs).toEqual(['dep_7']);

    // Stale OCC write loses with a conflict.
    await expect(
      decideIncidentStatus(ctx(), {
        id: inc.id,
        action: 'close',
        expected: 'open',
      }),
    ).rejects.toThrow(/stale write/);

    // Idempotent noop — same decision twice, no extra audit row.
    const again = await decideIncidentStatus(ctx(), {
      id: inc.id,
      action: 'resolve',
      expected: 'resolved',
      evidence: { deployment_refs: ['dep_7'] },
    });
    expect(again.status).toBe('resolved');
    const audit = await store.listIncidentDecisions({
      workspace: WS,
      incident_id: inc.id,
    });
    expect(audit.map((d) => d.status)).toEqual(['investigating', 'resolved']);
    const events = await store.listEvents({
      workspace: WS,
      event: 'incident_decided',
    });
    expect(events).toHaveLength(2);

    // Reopen clears verification.
    const reopened = await decideIncidentStatus(ctx(), {
      id: inc.id,
      action: 'reopen',
      expected: 'resolved',
    });
    expect(reopened.status).toBe('open');
    expect(reopened.resolution_verified).toBe(0);
  });
});

describe('draft-ticket gate', () => {
  it('a proposal creates NO scope until a human approves it', async () => {
    await seedSource();
    const r = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const inc = r.incidents_opened.at(0);

    const { id } = await proposeDraftTicket(ctx(), {
      incident_id: inc.id,
      title: 'Fix NPE in checkout handler',
      draft: { work_type: 'bug', severity: 'major' },
    });
    // Draft exists; no board item / ticket anywhere yet.
    let board = await store.listBoardItems({ workspace: WS });
    expect(board).toHaveLength(0);
    const prop = await store.getIncidentTicketProposal({
      workspace: WS,
      id,
    });
    expect(prop?.status).toBe('draft');

    const decided = await decideDraftTicket(ctx(), {
      id,
      action: 'approve',
      expected: 'draft',
    });
    expect(decided.status).toBe('approved');
    board = await store.listBoardItems({ workspace: WS });
    expect(board).toHaveLength(1);
    expect(board.at(0).kind).toBe('ticket');
    expect(board.at(0).board).toBeNull(); // capture tray, never committed scope
    expect(board.at(0).provenance).toBe('inferred');
    expect(board.at(0).ref).toBe(inc.id);

    // Repeat approve is a noop.
    const again = await decideDraftTicket(ctx(), {
      id,
      action: 'approve',
      expected: 'approved',
    });
    expect(again.status).toBe('approved');
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(1);
  });

  it('reject retires the proposal without creating work', async () => {
    await seedSource();
    const r = await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt()],
    });
    const { id } = await proposeDraftTicket(ctx(), {
      incident_id: r.incidents_opened.at(0).id,
      title: 'noise',
    });
    const res = await decideDraftTicket(ctx(), {
      id,
      action: 'reject',
      expected: 'draft',
    });
    expect(res.status).toBe('rejected');
    expect(res.board_item_id).toBeNull();
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(0);
  });
});

describe('retention', () => {
  it('prunes derived signatures/incidents without touching the backend', async () => {
    await seedSource();
    await ingestTelemetry(ctx(), {
      source_id: 'otel-prod',
      events: [evt({ timestamp: '2026-09-01T00:00:00Z' })],
    });
    const n = await store.pruneErrorSignatures({
      workspace: WS,
      before: '2026-10-01T00:00:00Z',
    });
    expect(n).toBe(1);
    expect(await store.listErrorSignatures({ workspace: WS })).toHaveLength(0);
    const m = await store.pruneIncidents({
      workspace: WS,
      before: '2026-10-07T00:00:00Z',
    });
    expect(m).toBe(1);
  });
});
