// @vitest-environment jsdom
/**
 * s-16 board canvas — chrome-level component tests.
 *
 * case:canvas-keyboard + case:canvas-responsive: the Board objects list
 * is the non-spatial access path, and read mode hides every mutation
 * affordance.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { BoardItem } from '@veto/core';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { projectItems } from '../src/board-canvas/model';
import { ObjectsPanel } from '../src/board-canvas/overlays';
import { ToolRail } from '../src/board-canvas/tools/rail';

afterEach(cleanup);

const item = (over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem => ({
  workspace: 'ws',
  board: 'ideas',
  kind: 'note',
  ref: null,
  title: null,
  body: null,
  x: 10,
  y: 10,
  w: null,
  h: null,
  zone: null,
  serves: null,
  status: 'active',
  consumed_by: null,
  note_kind: 'idea',
  topic: null,
  importance: null,
  applies_to: null,
  note_status: 'open',
  rationale: null,
  provenance: 'stakeholder-verified',
  created_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:00:00Z',
  ...over,
});

describe('Board objects list — case:canvas-keyboard', () => {
  it('lists every object in a deterministic reading order', () => {
    const nodes = projectItems([
      { item: item({ id: 'b', title: 'second', zone: 'z' }), statements: [] },
      { item: item({ id: 'a', title: 'first' }), statements: [] },
      { item: item({ id: 'z', kind: 'zone', title: 'frame' }), statements: [] },
    ]);
    render(
      <ObjectsPanel nodes={nodes} onLocate={() => {}} onClose={() => {}} />,
    );
    const rows = screen.getAllByRole('button', { name: /first|second|frame/ });
    // Unzoned sorts before zoned; 'a' before 'b' within the list.
    expect(rows[0]?.textContent).toContain('first');
    expect(rows[1]?.textContent).toContain('frame');
    expect(rows[2]?.textContent).toContain('second');
  });
});

describe('tool rail — case:canvas-tools-07', () => {
  it('read mode keeps participation tools and hides mutation chrome', () => {
    render(
      <ToolRail
        tool="select"
        onTool={() => {}}
        objectsOpen={false}
        onToggleObjects={() => {}}
        readOnly
        drawEnabled
        canPresent
        onPresent={() => {}}
      />,
    );
    // Mutation tools are absent entirely — no misleadingly-active chrome.
    for (const label of [
      'Sticky note',
      'Text',
      'Frame',
      'Connector',
      'Link',
      'Draw',
      'Present frames',
      'Image upload unavailable',
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    // Read-adjacent participation stays: select/pan/comment/vote/objects.
    for (const label of [
      'Select',
      'Pan (or hold Space)',
      'Comment',
      'Vote',
      'Board objects list',
    ]) {
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
  });

  it('draw renders only behind the canvas_draw flag', () => {
    const { rerender } = render(
      <ToolRail
        tool="select"
        onTool={() => {}}
        objectsOpen={false}
        onToggleObjects={() => {}}
        readOnly={false}
        drawEnabled={false}
        canPresent={false}
        onPresent={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Draw')).toBeNull();
    rerender(
      <ToolRail
        tool="select"
        onTool={() => {}}
        objectsOpen={false}
        onToggleObjects={() => {}}
        readOnly={false}
        drawEnabled
        canPresent={false}
        onPresent={() => {}}
      />,
    );
    expect(screen.getByLabelText('Draw')).toBeTruthy();
  });
});
