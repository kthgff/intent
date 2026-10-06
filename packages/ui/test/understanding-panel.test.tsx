// @vitest-environment jsdom
/**
 * wp-147 — Understanding Panel: the four buckets render with
 * provenance + human affordances; readiness is explainable indicators,
 * never an opaque score (PRD §15.3/§15.9).
 */
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Understanding } from '../src/api';
import UnderstandingPanel from '../src/screens/UnderstandingPanel';

afterEach(cleanup);

const statement = (over: Record<string, unknown> = {}) => ({
  workspace: 'ws',
  statement_id: 'st-1',
  version: 1,
  text: 'SSO must be optional',
  source_text: 'SSO must be optional',
  source_ref: { kind: 'interview-message', id: 'iv-x#2' },
  intent: 'requires',
  polarity: 'asserts',
  subject: null,
  strength: null,
  scope: null,
  scope_ref: null,
  status: 'proposed',
  confidence: 0.8,
  provenance: 'source-backed',
  extraction_run: 'er-1',
  created_by: 'e2e-bot',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const slot = (slotName: string, state: string) => ({
  workspace: 'ws',
  session_id: 'iv-x',
  slot: slotName,
  state,
  value: null,
  statement_refs: [],
  confidence: null,
  updated_at: '2026-10-01T00:00:00Z',
});

const understanding: Understanding = {
  session: {
    workspace: 'ws',
    session_id: 'iv-x',
    wizard_id: 'solution-discovery',
    wizard_version: 1,
    subject: 'board:ideas',
    mode: 'conversation',
    status: 'active',
    draft_ready: false,
    approval_ready: false,
    knowledge_version: null,
    created_by: 'test',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
  readiness: {
    draft_ready: false,
    approval_ready: false,
    required_total: 2,
    states: { missing: 1, inferred: 1 },
    draft_blockers: [
      { slot: 'problem', state: 'missing', reason: 'required slot is missing' },
    ],
    approval_blockers: [
      { slot: 'problem', state: 'missing', reason: 'required slot is missing' },
    ],
    open_decisions: [],
    summary: 'draft_ready=false approval_ready=false',
  },
  confirmed: {
    slots: [slot('audience', 'known')],
    statements: [statement({ statement_id: 'st-2', status: 'confirmed' })],
  },
  interpretation: {
    slots: [slot('value', 'inferred')],
    statements: [statement()],
  },
  needs_clarification: {
    slots: [slot('problem', 'missing')],
    clarifications: [],
  },
  decision_required: {
    slots: [],
    decisions: [
      {
        workspace: 'ws',
        decision_id: 'sd-1',
        statement_id: 'st-3',
        decision: null,
        status: 'open',
        rationale: 'disagreement on scope',
        decided_by: null,
        decided_at: null,
        created_by: 'e2e-bot',
        created_at: '2026-10-01T00:00:00Z',
        statement: statement({
          statement_id: 'st-3',
          status: 'disputed',
          text: 'Mobile support is in scope',
        }),
      },
    ],
    statements: [],
  },
};

describe('Understanding Panel (wp-147)', () => {
  it('renders the four buckets with statements, slots, and decisions', () => {
    render(
      <UnderstandingPanel
        ws="ws"
        sessionId="iv-x"
        understanding={understanding}
        onChanged={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.getByText('Understanding')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('Interpretation')).toBeTruthy();
    expect(screen.getByText('Needs clarification')).toBeTruthy();
    expect(screen.getByText('Decision required')).toBeTruthy();
    // Statements + their provenance + affordances.
    expect(screen.getAllByText('SSO must be optional').length).toBe(2);
    expect(screen.getByText('Mobile support is in scope')).toBeTruthy();
    expect(screen.getByText('disagreement on scope')).toBeTruthy();
    // Explainable blockers, never an opaque score.
    expect(
      screen.getAllByText(/required slot is missing/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('confirm/dispute/reject affordances are present per statement', () => {
    render(
      <UnderstandingPanel
        ws="ws"
        sessionId="iv-x"
        understanding={understanding}
        onChanged={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.getAllByText('confirm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('correct').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dispute').length).toBeGreaterThan(0);
    // The decision item carries a ruling input + apply buttons.
    expect(screen.getByLabelText('ruling')).toBeTruthy();
  });
});
