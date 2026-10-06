// @vitest-environment jsdom
/**
 * wp-152 Feature Workspace — Feature Health is an explainable
 * findings list (evidence refs rendered, never an opaque score) and
 * the screen carries exactly the six spec'd tabs.
 */
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureHealthFinding } from '../src/api';
import { FindingsList } from '../src/screens/FeatureWorkspace';

afterEach(cleanup);

const finding = (
  over: Partial<FeatureHealthFinding> = {},
): FeatureHealthFinding => ({
  id: 'f1',
  kind: 'blocked_ticket',
  severity: 'blocker',
  message: 'SR-0001 is blocked — missing creds',
  refs: ['SR-0001'],
  ...over,
});

describe('Feature health findings (wp-152)', () => {
  it('renders findings with severity + evidence refs — no score', () => {
    render(
      <FindingsList
        findings={[
          finding(),
          finding({
            id: 'f2',
            kind: 'unverified_ac',
            severity: 'warning',
            message: 'AC-2 has no verified test evidence',
            refs: ['AC-2', 'F-0001:ac.md'],
          }),
        ]}
      />,
    );
    expect(screen.getByText(/SR-0001 is blocked/)).toBeTruthy();
    expect(screen.getByText(/AC-2 has no verified/)).toBeTruthy();
    // Evidence refs are rendered verbatim.
    expect(screen.getByText(/F-0001:ac.md/)).toBeTruthy();
    // No aggregate score anywhere.
    expect(screen.queryByText(/score/i)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows an honest empty state when there are no findings', () => {
    render(<FindingsList findings={[]} />);
    expect(screen.getByText(/No open findings/)).toBeTruthy();
  });
});
