/**
 * design/states.ts — the screen-state generator (PRD §15.4, wp-149).
 *
 * The `mockup` stage's `states` mode expands an existing screen into the
 * state variants the product actually has (loading/empty/success/error/
 * permission/mobile). The LLM authors the CONTENT of each variant; this
 * module owns the MECHANICS so the output is always a valid tree:
 *
 *   - `expandScreenStates` clones the screen's component subtree per
 *     requested state, suffixing component ids (`c-x--loading`) so ids
 *     stay unique and stable per state;
 *   - the new tree is re-linted (dangling refs fail closed).
 *
 * Ids are deterministic: the same screen + state always yields the same
 * ids, so a re-run is a structural no-op.
 */
import {
  type Mockup,
  type MockupBreakpoint,
  type MockupState,
} from '@sprint-runner/core';
import { lintMockup } from './mockup.js';
import { badRequest } from './types.js';

/** Id suffix for a state variant: `c-submit` → `c-submit--loading`. */
export function stateSuffix(state: MockupState, breakpoint?: MockupBreakpoint): string {
  return breakpoint && breakpoint !== 'desktop'
    ? `--${state}--${breakpoint}`
    : `--${state}`;
}

/**
 * Expand a screen into state variants. Returns a NEW mockup: the
 * original tree is preserved and each requested state contributes a
 * cloned subtree whose component ids carry the state suffix and whose
 * `state` field is set. The screen's `states` list is extended.
 *
 * Fail-closed: an unknown screen, or an empty state list, throws.
 */
export function expandScreenStates(
  mockup: Mockup,
  args: {
    screenId: string;
    states: MockupState[];
    breakpoint?: MockupBreakpoint;
    /** Deep per-state content overrides keyed by the ORIGINAL component
     *  id — merged into the cloned component's props. */
    overrides?: Record<string, Record<string, unknown>>;
  },
): Mockup {
  const screen = mockup.screens.find((s) => s.screen_id === args.screenId);
  if (!screen) {
    throw badRequest(`state generator: no screen '${args.screenId}'`);
  }
  if (args.states.length === 0) {
    throw badRequest('state generator: at least one state is required');
  }
  const rootId = screen.root ?? undefined;
  if (!rootId) {
    throw badRequest(
      `state generator: screen '${args.screenId}' has no root component`,
    );
  }
  const byId = new Map(mockup.components.map((c) => [c.component_id, c]));
  const childrenOf = (id: string): string[] => byId.get(id)?.children ?? [];

  // Subtree component ids, root-first (deterministic DFS).
  const subtree: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    subtree.push(id);
    for (const child of childrenOf(id)) visit(child);
  };
  visit(rootId);

  const next: Mockup = {
    ...mockup,
    components: [...mockup.components],
    screens: mockup.screens.map((s) => ({ ...s, states: [...s.states] })),
    visual_acs: [...mockup.visual_acs],
  };
  const target = next.screens.find((s) => s.screen_id === args.screenId);
  if (!target) throw badRequest(`state generator: no screen '${args.screenId}'`);

  for (const state of args.states) {
    if (target.states.includes(state)) continue;
    const suffix = stateSuffix(state, args.breakpoint);
    const idMap = new Map<string, string>();
    for (const id of subtree) idMap.set(id, `${id}${suffix}`);
    for (const id of subtree) {
      const c = byId.get(id);
      if (!c) continue;
      const override = args.overrides?.[id] ?? {};
      next.components.push({
        ...c,
        component_id: idMap.get(id) as string,
        parent: c.parent ? (idMap.get(c.parent) ?? `${c.parent}${suffix}`) : null,
        children: c.children.map((ch) => idMap.get(ch) ?? `${ch}${suffix}`),
        props: { ...c.props, ...override },
        state,
        breakpoint: args.breakpoint ?? c.breakpoint ?? null,
      });
    }
    // Visual-AC edges that pointed at a cloned component follow the
    // state variant so coverage stays honest.
    for (const edge of mockup.visual_acs) {
      if (idMap.has(edge.component_id)) {
        next.visual_acs.push({
          ...edge,
          component_id: idMap.get(edge.component_id) as string,
          state,
          breakpoint: args.breakpoint ?? edge.breakpoint ?? null,
        });
      }
    }
    target.states.push(state);
  }

  lintMockup(next);
  return next;
}

/** The state variants a screen currently carries, in canonical order. */
export function screenStates(
  mockup: Mockup,
  screenId: string,
): MockupState[] {
  const screen = mockup.screens.find((s) => s.screen_id === screenId);
  if (!screen) return [];
  const order: MockupState[] = [
    'default',
    'loading',
    'empty',
    'success',
    'error',
    'permission',
  ];
  return order.filter((s) => screen.states.includes(s));
}
