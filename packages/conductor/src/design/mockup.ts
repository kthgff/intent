/**
 * design/mockup.ts — the `mockup.json` structured-artifact contract
 * (PRD §15.4, wp-149).
 *
 * The component tree is the SOURCE OF TRUTH. Rendered previews and
 * PNG/export are output, never source. This module owns:
 *
 *   - `parseMockup`      — fail-closed parse + internal-consistency lint
 *                          (dangling child/root/AC references block);
 *   - `diffMockups`      — STRUCTURAL diff (component/screen add/remove/
 *                          change + moved visual-AC edges), key-order
 *                          independent so a re-serialized tree is a
 *                          no-op;
 *   - `affectedAcs`      — which ACs a structural diff touches (the
 *                          basis for partial approval invalidation);
 *   - `visualAcEdges`    — AC → component+state edges (projected into
 *                          statement_artifact_links by wp-143);
 *   - `screenTree`       — nested render tree for a screen/state;
 *   - `requirementCoverage` — which ACs have ≥1 component + state.
 */
import {
  type Mockup,
  type MockupBreakpoint,
  MockupSchema,
  type MockupState,
  type MockupVisualAc,
} from '@veto/core';
import { badRequest, invalid, stableJson } from './types.js';

/** The doc kind every mockup revision lives under. */
export const MOCKUP_DOC = 'mockup.json';

/** Parse + lint a mockup.json document. Fail-closed: malformed JSON,
 *  schema violations, or dangling references all throw. */
export function parseMockup(content: string): Mockup {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw badRequest(`mockup.json: invalid JSON — ${(e as Error).message}`);
  }
  const parsed = MockupSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      `mockup.json: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'} ${i.message}`)
        .join('; ')}`,
    );
  }
  const mockup = parsed.data;
  lintMockup(mockup);
  return mockup;
}

/**
 * Internal-consistency lint (§15.4): every referenced component id must
 * exist, ids must be unique, and screen roots must resolve. A dangling
 * reference is a malformed tree — fail closed rather than render junk.
 */
export function lintMockup(mockup: Mockup): void {
  const ids = new Set<string>();
  for (const c of mockup.components) {
    if (ids.has(c.component_id)) {
      throw invalid(`mockup.json: duplicate component_id '${c.component_id}'`);
    }
    ids.add(c.component_id);
  }
  for (const c of mockup.components) {
    for (const child of c.children) {
      if (!ids.has(child)) {
        throw invalid(
          `mockup.json: component '${c.component_id}' references missing child '${child}'`,
        );
      }
    }
    if (c.parent !== null && c.parent !== undefined && !ids.has(c.parent)) {
      throw invalid(
        `mockup.json: component '${c.component_id}' references missing parent '${c.parent}'`,
      );
    }
  }
  const screenIds = new Set<string>();
  for (const s of mockup.screens) {
    if (screenIds.has(s.screen_id)) {
      throw invalid(`mockup.json: duplicate screen_id '${s.screen_id}'`);
    }
    screenIds.add(s.screen_id);
    if (s.root !== null && s.root !== undefined && !ids.has(s.root)) {
      throw invalid(
        `mockup.json: screen '${s.screen_id}' root '${s.root}' does not exist`,
      );
    }
    for (const root of Object.values(s.responsive ?? {})) {
      if (!ids.has(root)) {
        throw invalid(
          `mockup.json: screen '${s.screen_id}' responsive root '${root}' does not exist`,
        );
      }
    }
  }
  for (const edge of mockup.visual_acs) {
    if (!ids.has(edge.component_id)) {
      throw invalid(
        `mockup.json: visual AC '${edge.ac_id}' references missing component '${edge.component_id}'`,
      );
    }
    if (edge.screen_id !== null && edge.screen_id !== undefined) {
      if (!screenIds.has(edge.screen_id)) {
        throw invalid(
          `mockup.json: visual AC '${edge.ac_id}' references missing screen '${edge.screen_id}'`,
        );
      }
    }
  }
}

/** Index components by id. */
export function componentIndex(
  mockup: Mockup,
): Map<string, Mockup['components'][number]> {
  return new Map(mockup.components.map((c) => [c.component_id, c]));
}

/** AC → component+state edges (§15.4 Visual ACs). Deterministic order. */
export function visualAcEdges(mockup: Mockup): MockupVisualAc[] {
  return [...mockup.visual_acs].sort((a, b) =>
    stableJson(a).localeCompare(stableJson(b)),
  );
}

/** AC ids carried by the tree — from component `requirement` links and
 *  visual-AC edges, deduped + sorted. */
export function mockupAcs(mockup: Mockup): string[] {
  const acs = new Set<string>();
  for (const c of mockup.components) {
    if (c.requirement) acs.add(c.requirement);
  }
  for (const s of mockup.screens) {
    if (s.requirement) acs.add(s.requirement);
  }
  for (const e of mockup.visual_acs) acs.add(e.ac_id);
  return [...acs].sort();
}

export interface RequirementCoverage {
  ac_id: string;
  components: string[];
  states: string[];
  covered: boolean;
}

/** Per-AC coverage: which components/states satisfy it. An AC with no
 *  component or no state is a visible gap (never silently passes). */
export function requirementCoverage(mockup: Mockup): RequirementCoverage[] {
  const byAc = new Map<
    string,
    { components: Set<string>; states: Set<string> }
  >();
  const touch = (ac: string) => {
    let entry = byAc.get(ac);
    if (!entry) {
      entry = { components: new Set(), states: new Set() };
      byAc.set(ac, entry);
    }
    return entry;
  };
  for (const c of mockup.components) {
    if (!c.requirement) continue;
    const entry = touch(c.requirement);
    entry.components.add(c.component_id);
    if (c.state) entry.states.add(c.state);
  }
  for (const e of mockup.visual_acs) {
    const entry = touch(e.ac_id);
    entry.components.add(e.component_id);
    entry.states.add(e.state ?? 'default');
  }
  return [...byAc.entries()]
    .map(([ac_id, { components, states }]) => ({
      ac_id,
      components: [...components].sort(),
      states: [...states].sort(),
      covered: components.size > 0 && states.size > 0,
    }))
    .sort((a, b) => a.ac_id.localeCompare(b.ac_id));
}

// ---------------------------------------------------------------------------
// structural diff
// ---------------------------------------------------------------------------

export interface MockupDiff {
  from_version: number;
  to_version: number;
  added_components: string[];
  removed_components: string[];
  changed_components: string[];
  added_screens: string[];
  removed_screens: string[];
  changed_screens: string[];
  /** AC ids whose component+state edge set changed. */
  moved_ac_links: string[];
  /** True when any structural change exists (component/screen/AC edge). */
  material: boolean;
}

/** Normalized component payload — everything EXCEPT nothing (ids are
 *  stable, so any field change is material). Key-order independent. */
function componentKey(c: Mockup['components'][number]): string {
  return stableJson(c);
}

function screenKey(s: Mockup['screens'][number]): string {
  return stableJson(s);
}

/** AC → sorted "component|state|breakpoint" edge set. */
function acEdgeMap(mockup: Mockup): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const e of mockup.visual_acs) {
    const set = map.get(e.ac_id) ?? new Set<string>();
    set.add(`${e.component_id}|${e.state ?? ''}|${e.breakpoint ?? ''}`);
    map.set(e.ac_id, set);
  }
  const out = new Map<string, string[]>();
  for (const [ac, set] of map) out.set(ac, [...set].sort());
  return out;
}

/**
 * STRUCTURAL diff between two mockup revisions (§15.4). Components are
 * keyed by `component_id` — ids are stable across revisions, so a moved
 * or edited component reads as `changed`, an added one as `added`.
 */
export function diffMockups(
  from: Mockup,
  to: Mockup,
  versions: { from: number; to: number },
): MockupDiff {
  const a = componentIndex(from);
  const b = componentIndex(to);
  const added_components: string[] = [];
  const removed_components: string[] = [];
  const changed_components: string[] = [];
  for (const id of b.keys()) if (!a.has(id)) added_components.push(id);
  for (const id of a.keys()) if (!b.has(id)) removed_components.push(id);
  for (const [id, ca] of a) {
    const cb = b.get(id);
    if (cb && componentKey(ca) !== componentKey(cb))
      changed_components.push(id);
  }

  const sa = new Map(from.screens.map((s) => [s.screen_id, s]));
  const sb = new Map(to.screens.map((s) => [s.screen_id, s]));
  const added_screens: string[] = [];
  const removed_screens: string[] = [];
  const changed_screens: string[] = [];
  for (const id of sb.keys()) if (!sa.has(id)) added_screens.push(id);
  for (const id of sa.keys()) if (!sb.has(id)) removed_screens.push(id);
  for (const [id, s1] of sa) {
    const s2 = sb.get(id);
    if (s2 && screenKey(s1) !== screenKey(s2)) changed_screens.push(id);
  }

  const ea = acEdgeMap(from);
  const eb = acEdgeMap(to);
  const moved_ac_links: string[] = [];
  for (const ac of new Set([...ea.keys(), ...eb.keys()])) {
    if (stableJson(ea.get(ac) ?? []) !== stableJson(eb.get(ac) ?? [])) {
      moved_ac_links.push(ac);
    }
  }

  const sort = (x: string[]) => x.sort();
  const material =
    added_components.length > 0 ||
    removed_components.length > 0 ||
    changed_components.length > 0 ||
    added_screens.length > 0 ||
    removed_screens.length > 0 ||
    changed_screens.length > 0 ||
    moved_ac_links.length > 0;

  return {
    from_version: versions.from,
    to_version: versions.to,
    added_components: sort(added_components),
    removed_components: sort(removed_components),
    changed_components: sort(changed_components),
    added_screens: sort(added_screens),
    removed_screens: sort(removed_screens),
    changed_screens: sort(changed_screens),
    moved_ac_links: sort(moved_ac_links),
    material,
  };
}

/**
 * ACs a structural diff touches — the basis for partial approval
 * invalidation. Union of moved AC edges plus the ACs referenced by any
 * added/removed/changed component (in either revision) or changed
 * screen.
 */
export function affectedAcs(
  diff: MockupDiff,
  from: Mockup,
  to: Mockup,
): string[] {
  const acs = new Set<string>(diff.moved_ac_links);
  const touchedComponents = new Set([
    ...diff.added_components,
    ...diff.removed_components,
    ...diff.changed_components,
  ]);
  for (const mockup of [from, to]) {
    for (const c of mockup.components) {
      if (touchedComponents.has(c.component_id) && c.requirement) {
        acs.add(c.requirement);
      }
    }
    for (const e of mockup.visual_acs) {
      if (touchedComponents.has(e.component_id)) acs.add(e.ac_id);
    }
    const touchedScreens = new Set([
      ...diff.added_screens,
      ...diff.removed_screens,
      ...diff.changed_screens,
    ]);
    for (const s of mockup.screens) {
      if (touchedScreens.has(s.screen_id) && s.requirement) {
        acs.add(s.requirement);
      }
    }
  }
  return [...acs].sort();
}

// ---------------------------------------------------------------------------
// render tree
// ---------------------------------------------------------------------------

export interface RenderNode {
  component_id: string;
  name: string;
  kind: string | null;
  props: Record<string, unknown>;
  layout: unknown;
  requirement: string | null;
  children: RenderNode[];
}

/**
 * Nested render tree for a screen (+ state). Children are ordered as
 * declared; a cycle or missing id fails closed (the tree is already
 * linted, so this is a belt-and-braces guard for callers passing raw
 * objects).
 */
export function screenTree(
  mockup: Mockup,
  screenId: string,
  opts: { state?: MockupState; breakpoint?: MockupBreakpoint } = {},
): RenderNode | null {
  const screen = mockup.screens.find((s) => s.screen_id === screenId);
  if (!screen) return null;
  const byId = componentIndex(mockup);
  const rootId =
    (opts.breakpoint ? screen.responsive?.[opts.breakpoint] : undefined) ??
    screen.root ??
    undefined;
  if (!rootId) return null;
  const seen = new Set<string>();
  const build = (id: string): RenderNode | null => {
    if (seen.has(id)) return null; // cycle guard
    seen.add(id);
    const c = byId.get(id);
    if (!c) return null;
    return {
      component_id: c.component_id,
      name: c.name,
      kind: c.kind ?? null,
      props: c.props,
      layout: c.layout ?? null,
      requirement: c.requirement ?? null,
      children: c.children
        .map((child) => build(child))
        .filter((n): n is RenderNode => n !== null),
    };
  };
  return build(rootId);
}
