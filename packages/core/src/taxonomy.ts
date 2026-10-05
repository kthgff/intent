/**
 * Ticket taxonomy policy (PRD §15.7, wp-151) — the data-driven rules
 * that make work type × origin separate dimensions, encode per-type
 * intake + completion evidence, and keep bug ≠ scope change a
 * *semantic* distinction rather than a label convention.
 *
 * Everything here is policy *data* + pure evaluation. The conductor
 * enforces it at stage gates (triage intake, `test-approved`,
 * `approved`); the API enforces the direct-create rules on intake
 * routes; the UI renders `tabs`. No per-type code paths — adding a
 * type is a table edit, not a branch.
 */
import { z } from 'zod';
import {
  RELATION_PREDICATES,
  TICKET_ORIGINS,
  TICKET_SEVERITIES,
  TICKET_WORK_TYPES,
  type TicketOrigin,
  type TicketSeverity,
  type TicketWorkType,
} from './enums.js';
import type { Store } from './store.js';

const enumOf = (values: readonly string[]) =>
  z.enum(values as [string, ...string[]]);

// ---------- scope verdicts (§15.7 "Bug ≠ scope change") ----------

/**
 * The intake classifier's semantic verdict — what the request *is*,
 * independent of which label it was filed under:
 *
 * - `defect` — restores already-approved behavior (a bug; direct-create
 *   is allowed).
 * - `new-capability` — introduces capability beyond approved scope
 *   (rides the board/ChangeSet path; never silently a "bug fix").
 * - `mixed` — part defect, part capability: the conductor surfaces a
 *   scope proposal rather than absorbing the extra scope.
 */
export const SCOPE_VERDICTS = ['defect', 'new-capability', 'mixed'] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

/** Origins that already carry an approved scope decision: `rs` =
 *  authored from an approved requirements spec, `board` = an approved
 *  board proposal. Every other story needs the scope-proposal gate. */
export const APPROVED_SCOPE_ORIGINS = ['rs', 'board'] as const;

// ---------- typed ticket relations (§15.7) ----------

/** The §15.7 ticket-relation verbs — a subset of the §12
 *  `relations` predicate vocabulary stored with subject
 *  `ticket:<ws>:<id>` (same convention as kb prior-art). */
export const TICKET_RELATION_PREDICATES = [
  'implements',
  'fixes',
  'blocks',
  'belongs-to',
  'follows',
] as const;
export type TicketRelationPredicate =
  (typeof TICKET_RELATION_PREDICATES)[number];

/** relations.subject/object ref for a ticket row. */
export const ticketRef = (workspace: string, ticketId: string): string =>
  `ticket:${workspace}:${ticketId}`;

/**
 * Normalize a relation target: a `kind:id` ref (`feature:`, `rs:`,
 * `ticket:`…) is kept verbatim; a bare ticket id resolves to the
 * ticket ref in this workspace.
 */
export function normalizeRelationTarget(
  workspace: string,
  target: string,
): string {
  const t = target.trim();
  return /^[a-z-]+:/.test(t) ? t : ticketRef(workspace, t);
}

// ---------- intake fields + evidence requirements ----------

/** One question in a type's intake set — the interview/triage agent is
 *  asked to fill it; a human may answer it through the wizard instead. */
export const IntakeFieldSchema = z.object({
  /** Stable key — `classification.intake.<key>` in triage.json and
   *  the synthesized `intake:<key>` question id share it. */
  key: z.string().min(1),
  /** `## <title>` section heading the value may live under in
   *  ticket.md (case-insensitive match). */
  title: z.string().min(1),
  /** The question the intake flow asks for this slot. */
  question: z.string().min(1),
  required: z.boolean().default(true),
});
export type IntakeField = z.infer<typeof IntakeFieldSchema>;

/** Question-id prefix for synthesized intake questions — an answered
 *  `intake:<key>` triage question satisfies intake slot `key`. */
export const INTAKE_QUESTION_PREFIX = 'intake:';

/**
 * Machine-checkable evidence. `gate` names the pipeline boundary the
 * conductor enforces it at:
 *
 * - `intake` — before `imported → ready` (missing ⇒ needs-info round
 *   with synthesized questions; never a silent default);
 * - `test-approved` — the spec-complete boundary (before the spend
 *   checkpoint opens implementation);
 * - `approved` — the merge boundary (verified-fix evidence).
 */
export const EVIDENCE_GATES = ['intake', 'test-approved', 'approved'] as const;
export type EvidenceGate = (typeof EVIDENCE_GATES)[number];

/** Row fields an evidence check may inspect (kept as a tuple so the
 *  inferred type is the key union, not `string`). */
export const EVIDENCE_FIELDS = [
  'work_type',
  'origin',
  'severity',
  'parent',
  'feature',
] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

export const EvidenceCheckSchema = z.discriminatedUnion('kind', [
  /** A tickets-row field is non-null (e.g. `severity`, `parent`). */
  z.object({
    kind: z.literal('field'),
    field: z.enum(EVIDENCE_FIELDS),
  }),
  /** The intake slot is answered — `classification.intake[key]`, an
   *  answered `intake:<key>` question, or a non-empty `## <title>`
   *  section in ticket.md all satisfy it. */
  z.object({ kind: z.literal('intake'), key: z.string().min(1) }),
  /** ticket.md contains a non-empty `## <section>`. */
  z.object({ kind: z.literal('section'), section: z.string().min(1) }),
  /** A `doc_versions` doc exists for the ticket subject. */
  z.object({ kind: z.literal('doc'), doc: z.string().min(1) }),
  /** The named `doc_versions` doc mentions `needle`
   *  (case-insensitive) — e.g. a repro case row in test.md. */
  z.object({
    kind: z.literal('doc-contains'),
    doc: z.string().min(1),
    needle: z.string().min(1),
  }),
  /** ≥1 typed relation edge from `ticket:<ws>:<id>`. */
  z.object({
    kind: z.literal('relation'),
    predicate: enumOf(TICKET_RELATION_PREDICATES),
  }),
  /** A verify-stage run for the ticket produced a passing
   *  test-report.json (`pass_pct >= 100`, no failing case — same rule
   *  as the conductor's verifyDone reconcile). */
  z.object({ kind: z.literal('verify-pass') }),
]);
export type EvidenceCheck = z.infer<typeof EvidenceCheckSchema>;

export const EvidenceRequirementSchema = z.object({
  id: z.string().min(1),
  gate: enumOf(EVIDENCE_GATES),
  check: EvidenceCheckSchema,
  /** Human-readable statement surfaced in gate payloads + workbench. */
  label: z.string().min(1),
});
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

/** Workbench tab ids — the per-type surfaces PRD §15.7 names plus the
 *  shared `type` tab (policy + evidence checklist). */
export const WORKBENCH_TABS = [
  'type',
  'repro',
  'telemetry',
  'findings',
  'migration-checks',
  'ac-design',
] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

export interface WorkTypePolicy {
  /** Engineers may file this type directly (POST /tickets). Stories
   *  are excluded — they must originate from approved RS/board
   *  proposals (§15.7). */
  direct_create: boolean;
  /** The intake question set for this type. */
  intake: IntakeField[];
  /** Completion/intake evidence beyond the intake slots themselves. */
  evidence: EvidenceRequirement[];
  /** Ticket Workbench tabs for this type (rendered after `type`). */
  tabs: WorkbenchTab[];
  /** One-line type summary for prompts + UI. */
  summary: string;
}

const intake = (key: string, title: string, question: string): IntakeField =>
  IntakeFieldSchema.parse({ key, title, question });
const optionalIntake = (
  key: string,
  title: string,
  question: string,
): IntakeField =>
  IntakeFieldSchema.parse({ key, title, question, required: false });
const req = (
  id: string,
  gate: EvidenceGate,
  check: EvidenceCheck,
  label: string,
): EvidenceRequirement =>
  EvidenceRequirementSchema.parse({ id, gate, check, label });

const VERIFY_PASS = req(
  'verified-fix',
  'approved',
  { kind: 'verify-pass' },
  'a verify run passed (test-report.json 100%, no failing case)',
);

/**
 * §15.7 per-type policies. `intake` slots are enforced at the intake
 * gate; `evidence` rows carry their own gate. This table is the whole
 * policy — the conductor holds no per-type branches.
 */
export const WORK_TYPE_POLICIES: Record<TicketWorkType, WorkTypePolicy> = {
  bug: {
    direct_create: true,
    summary: 'restores already-approved behavior (defect, not scope)',
    intake: [
      intake(
        'expected',
        'Expected behavior',
        'What is the approved/expected behavior?',
      ),
      intake('actual', 'Actual behavior', 'What does it actually do instead?'),
      intake('repro', 'Repro', 'Steps to reproduce?'),
      optionalIntake('logs', 'Logs', 'Error output, logs, or telemetry links?'),
      optionalIntake(
        'telemetry',
        'Telemetry',
        'Incidents/error signatures confirming the defect?',
      ),
    ],
    evidence: [
      req(
        'repro-case',
        'test-approved',
        { kind: 'doc-contains', doc: 'test.md', needle: 'repro' },
        'test plan contains a repro case for the bug',
      ),
      VERIFY_PASS,
    ],
    tabs: ['type', 'repro', 'telemetry'],
  },
  story: {
    direct_create: false,
    summary:
      'new capability — originates from an approved RS or board proposal',
    intake: [
      intake(
        'scope-ref',
        'Scope',
        'Which approved RS / board proposal authorizes this work?',
      ),
    ],
    evidence: [
      req(
        'acceptance-criteria',
        'intake',
        { kind: 'section', section: 'Acceptance criteria' },
        'ticket.md has non-empty ## Acceptance criteria',
      ),
      VERIFY_PASS,
    ],
    tabs: ['type', 'ac-design'],
  },
  technical: {
    direct_create: true,
    summary: 'maintenance/refactor/paydown — no new user-facing scope',
    intake: [
      intake('rationale', 'Rationale', 'Why is this work needed now?'),
      intake('boundary', 'Scope boundary', 'What stays out of scope?'),
    ],
    evidence: [VERIFY_PASS],
    tabs: ['type'],
  },
  spike: {
    direct_create: true,
    summary: 'time-boxed investigation — output is findings, not code',
    intake: [
      intake('question', 'Question', 'What question does the spike answer?'),
      intake('timebox', 'Timebox', 'What is the time/effort box?'),
    ],
    evidence: [
      req(
        'findings',
        'approved',
        { kind: 'doc', doc: 'notes.md' },
        'findings recorded in a notes.md doc on the ticket',
      ),
    ],
    tabs: ['type', 'findings'],
  },
  security: {
    direct_create: true,
    summary: 'vulnerability/threat work — carries severity like a bug',
    intake: [
      intake(
        'threat',
        'Threat',
        'What vulnerability/threat does this address?',
      ),
      optionalIntake('vector', 'Vector', 'Attack vector or exposure?'),
    ],
    evidence: [VERIFY_PASS],
    tabs: ['type'],
  },
  infrastructure: {
    direct_create: true,
    summary: 'ops/runtime work — CI, environments, deploys',
    intake: [
      intake(
        'rationale',
        'Rationale',
        'What operational need does this serve?',
      ),
    ],
    evidence: [VERIFY_PASS],
    tabs: ['type'],
  },
  data: {
    direct_create: true,
    summary: 'schema/data migration — ships with migration checks',
    intake: [
      intake('change', 'Change', 'What schema/data change ships?'),
      intake('rollback', 'Rollback', 'How does it roll back safely?'),
    ],
    evidence: [
      req(
        'migration-checks',
        'test-approved',
        { kind: 'doc-contains', doc: 'test.md', needle: 'migration' },
        'test plan includes migration checks',
      ),
      VERIFY_PASS,
    ],
    tabs: ['type', 'migration-checks'],
  },
  documentation: {
    direct_create: true,
    summary: 'docs-only change — the doc edit is the deliverable',
    intake: [intake('audience', 'Audience', 'Who is this documentation for?')],
    evidence: [],
    tabs: ['type'],
  },
  quality: {
    direct_create: true,
    summary: 'test/tooling/quality work that changes no behavior',
    intake: [intake('target', 'Target', 'What quality gap does this close?')],
    evidence: [VERIFY_PASS],
    tabs: ['type'],
  },
};

/** Per-origin evidence — `correction` tickets must link the ticket
 *  they correct (DELIVERY §2 carries it on `parent`). */
export const ORIGIN_EVIDENCE: Partial<
  Record<TicketOrigin, EvidenceRequirement[]>
> = {
  correction: [
    req(
      'corrects-parent',
      'intake',
      { kind: 'field', field: 'parent' },
      'links the ticket it corrects (parent)',
    ),
  ],
};

// ---------- classification (triage.json `classification` block) ----------

/** The taxonomy block a triage run (or the classification API) emits.
 *  `work_type`/`scope_verdict` are required when the block is present
 *  — a partial classification is malformed structured output and the
 *  conductor fails closed on it. */
export const IntakeClassificationSchema = z.object({
  work_type: enumOf(TICKET_WORK_TYPES),
  /** Proposed provenance override — the creation path already stamps
   *  origin; set this only when the triage agent knows better
   *  (e.g. `review` for a ticket filed from a review finding). */
  origin: enumOf(TICKET_ORIGINS).nullish(),
  severity: enumOf(TICKET_SEVERITIES).nullish(),
  scope_verdict: enumOf(SCOPE_VERDICTS),
  /** One-line basis for the verdict (surfaced on the scope gate). */
  rationale: z.string().nullish(),
  /** Per-type intake slots the agent could answer itself. */
  intake: z.record(z.string(), z.string()).default({}),
  /** Typed relations the intake run identified (§15.7 verbs). */
  relations: z
    .array(
      z.object({
        predicate: enumOf(TICKET_RELATION_PREDICATES),
        target: z.string().min(1),
      }),
    )
    .default([]),
});
export type IntakeClassification = z.infer<typeof IntakeClassificationSchema>;

// ---------- policy evaluation ----------

/**
 * Whether engineers may create this type directly (POST /tickets).
 * `story` is the only excluded type: it must arrive via approved
 * RS/board materialization or the scope-proposal gate.
 */
export const directCreateAllowed = (type: TicketWorkType): boolean =>
  WORK_TYPE_POLICIES[type].direct_create;

/** `severity` is Priority≠severity (§15.7): it applies to bugs,
 *  security work, and anything incident-sourced; it is *forbidden* on
 *  other types so it can never quietly mean "importance". */
export function severityRule(
  workType: TicketWorkType,
  origin: TicketOrigin | null,
): 'required' | 'optional' | 'forbidden' {
  if (workType === 'bug' || workType === 'security') return 'required';
  if (origin === 'incident') return 'required';
  return 'forbidden';
}

/**
 * Does this ticket still need a human scope decision? True when the
 * intake verdict says the work exceeds approved scope
 * (`new-capability`/`mixed`) or it is a `story` without an
 * approved-scope origin — and the scope-proposal gate hasn't already
 * been cleared (the clearance IS the approval).
 */
export function needsScopeApproval(
  workType: TicketWorkType | null,
  origin: TicketOrigin | null,
  verdict: ScopeVerdict | null,
  scopeApproved: boolean,
): boolean {
  if (scopeApproved) return false;
  if (verdict === 'new-capability' || verdict === 'mixed') return true;
  return (
    workType === 'story' &&
    !APPROVED_SCOPE_ORIGINS.includes(
      origin as (typeof APPROVED_SCOPE_ORIGINS)[number],
    )
  );
}

/** The field snapshot evaluation runs against — gathered once per
 *  check by the caller (conductor/API), evaluated purely here. */
export interface EvidenceSnapshot {
  /** Row-field values (nulls included — `field` checks fail on null). */
  fields: Record<EvidenceField, string | null>;
  /** Resolved intake slots — classification.intake merged with
   *  answered `intake:*` questions across all triage.json artifacts. */
  intake: Record<string, string>;
  /** `## <section>` headings present in ticket.md (lowercased). */
  sections: ReadonlySet<string>;
  /** doc_versions doc names present on the ticket subject. */
  docs: ReadonlySet<string>;
  /** Relation predicates with an edge from this ticket's ref. */
  relations: ReadonlySet<string>;
  /** Any verify-stage run produced a fully-passing test-report. */
  verifyPass: boolean;
}

/** All evidence a ticket must satisfy — work-type policy + required
 *  intake slots (gate `intake`) + severity rule + origin rules. */
export function evidenceFor(
  workType: TicketWorkType | null,
  origin: TicketOrigin | null,
): EvidenceRequirement[] {
  const out: EvidenceRequirement[] = [];
  if (workType !== null) {
    const policy = WORK_TYPE_POLICIES[workType];
    for (const f of policy.intake) {
      if (!f.required) continue;
      out.push(
        req(
          `intake:${f.key}`,
          'intake',
          { kind: 'intake', key: f.key },
          f.question,
        ),
      );
    }
    out.push(...policy.evidence);
  }
  const rule = workType === null ? 'forbidden' : severityRule(workType, origin);
  if (rule === 'required') {
    out.push(
      req(
        'severity',
        'intake',
        { kind: 'field', field: 'severity' },
        'severity is set (severity ≠ priority for bugs/incidents)',
      ),
    );
  }
  if (origin !== null) out.push(...(ORIGIN_EVIDENCE[origin] ?? []));
  return out;
}

/** Evaluate a single check against the snapshot. */
export function checkSatisfied(
  check: EvidenceCheck,
  snapshot: EvidenceSnapshot,
  intakeFields: IntakeField[] = [],
): boolean {
  switch (check.kind) {
    case 'field':
      return snapshot.fields[check.field] !== null;
    case 'intake': {
      const v = snapshot.intake[check.key];
      if (v !== undefined && v.trim() !== '') return true;
      // Fallback: a `## <title>` section holding the answer — intake
      // landed in ticket.md (direct-create renders it there).
      const title = intakeFields
        .find((f) => f.key === check.key)
        ?.title.toLowerCase();
      return title !== undefined && snapshot.sections.has(title);
    }
    case 'section':
      return snapshot.sections.has(check.section.toLowerCase());
    case 'doc':
      return snapshot.docs.has(check.doc);
    case 'doc-contains':
      return snapshot.docs.has(`${check.doc}\0${check.needle.toLowerCase()}`);
    case 'relation':
      return snapshot.relations.has(check.predicate);
    case 'verify-pass':
      return snapshot.verifyPass;
  }
}

export interface EvidenceVerdict {
  /** Requirements now satisfied. */
  satisfied: EvidenceRequirement[];
  /** Requirements still missing — the gate payload lists these. */
  missing: EvidenceRequirement[];
}

/**
 * Evaluate the policy for a ticket at `gate`. `workType`/`origin` come
 * from the *effective* classification (row ⊕ classification result) —
 * callers pass what they resolved.
 */
export function evaluateEvidence(
  workType: TicketWorkType | null,
  origin: TicketOrigin | null,
  gate: EvidenceGate,
  snapshot: EvidenceSnapshot,
): EvidenceVerdict {
  const policy = workType === null ? null : WORK_TYPE_POLICIES[workType];
  const all = evidenceFor(workType, origin).filter((r) => r.gate === gate);
  const satisfied: EvidenceRequirement[] = [];
  const missing: EvidenceRequirement[] = [];
  for (const r of all) {
    (checkSatisfied(r.check, snapshot, policy?.intake ?? [])
      ? satisfied
      : missing
    ).push(r);
  }
  return { satisfied, missing };
}

// ---------- snapshot gathering (shared by conductor + API) ----------

const SECTION_RE = /^##\s+(.+?)\s*$/gm;

/** `## Heading` names in a markdown doc (lowercased set). */
export function markdownSections(md: string | null): Set<string> {
  const out = new Set<string>();
  if (!md) return out;
  for (const m of md.matchAll(SECTION_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return out;
}

function triageIntakeInto(
  into: Record<string, string>,
  artifact: string | null,
): void {
  if (!artifact) return;
  let parsed: {
    classification?: { intake?: Record<string, unknown> };
    questions?: Array<{
      id?: string;
      status?: string;
      answer?: string | string[] | null;
    }>;
  };
  try {
    parsed = JSON.parse(artifact) as typeof parsed;
  } catch {
    return; // malformed artifact — other paths fail closed on it
  }
  for (const [k, v] of Object.entries(parsed.classification?.intake ?? {})) {
    if (typeof v === 'string' && v.trim() !== '') into[k] = v;
  }
  for (const q of parsed.questions ?? []) {
    if (
      q.id?.startsWith(INTAKE_QUESTION_PREFIX) &&
      q.status === 'answered' &&
      q.answer !== null &&
      q.answer !== undefined
    ) {
      const key = q.id.slice(INTAKE_QUESTION_PREFIX.length);
      const value = Array.isArray(q.answer) ? q.answer.join(', ') : q.answer;
      if (value.trim() !== '' && into[key] === undefined) into[key] = value;
    }
  }
}

/** Does the newest passing verify run exist for this ticket? */
async function verifyPassed(
  store: Store,
  workspace: string,
  ticketId: string,
): Promise<boolean> {
  const runs = (await store.listRuns({ workspace, ticket_id: ticketId }))
    .filter((r) => r.stage === 'verify')
    .sort((a, b) => b.id.localeCompare(a.id));
  for (const r of runs) {
    const names = [await store.getArtifact(r.id, 'test-report.json')];
    if (names[0] === null) {
      const nested = (await store.listArtifacts(r.id)).filter((a) =>
        a.name.endsWith('/test-report.json'),
      );
      names.push(...nested);
    }
    for (const a of names) {
      if (!a) continue;
      try {
        const parsed = JSON.parse(a.content) as {
          pass_pct?: number;
          cases?: { result?: string }[];
        };
        if (
          (parsed.pass_pct ?? 0) >= 100 &&
          (parsed.cases ?? []).every((c) => c.result !== 'fail')
        ) {
          return true;
        }
      } catch {
        /* malformed report — this run doesn't count */
      }
    }
  }
  return false;
}

/**
 * Gather the evidence snapshot for one ticket. Reads triage.json
 * across ALL the ticket's runs (answered `intake:*` questions persist
 * on the artifact that surfaced them even when a later run rewrites
 * triage.json) — intake answers are durable by construction, never
 * re-asked.
 */
export async function gatherEvidenceSnapshot(
  store: Store,
  workspace: string,
  ticket: {
    ticket_id: string;
    work_type: string | null;
    origin: string | null;
    severity: string | null;
    parent: string | null;
    feature: string | null;
  },
): Promise<EvidenceSnapshot> {
  const intakeMap: Record<string, string> = {};
  const runs = (
    await store.listRuns({ workspace, ticket_id: ticket.ticket_id })
  ).sort((a, b) => a.id.localeCompare(b.id)); // oldest first — later wins
  for (const r of runs) {
    const names = ['triage.json'];
    for (const name of names) {
      const bare = await store.getArtifact(r.id, name);
      const nested = bare
        ? null
        : await store.getArtifact(r.id, `${ticket.ticket_id}/${name}`);
      triageIntakeInto(intakeMap, (bare ?? nested)?.content ?? null);
    }
  }
  const ticketMd = (
    await store.getDoc({
      workspace,
      subject: ticket.ticket_id,
      doc: 'ticket.md',
    })
  )?.content;
  const sections = markdownSections(ticketMd ?? null);
  const docs = new Set<string>(
    (await store.listDocs({ workspace, subject: ticket.ticket_id })).map(
      (d) => d.doc,
    ),
  );
  // doc-contains checks need the doc bodies — resolved lazily by
  // stuffing `doc\0needle` markers into the docs set (cheap: only docs
  // the policy could ask about are fetched).
  const policy =
    ticket.work_type === null
      ? null
      : WORK_TYPE_POLICIES[ticket.work_type as TicketWorkType];
  const wanted = (policy?.evidence ?? [])
    .concat(ORIGIN_EVIDENCE[ticket.origin as TicketOrigin] ?? [])
    .filter(
      (
        r,
      ): r is Extract<EvidenceCheck, { kind: 'doc-contains' }> extends never
        ? never
        : EvidenceRequirement & {
            check: { kind: 'doc-contains'; doc: string; needle: string };
          } => r.check.kind === 'doc-contains',
    );
  for (const r of wanted) {
    if (!docs.has(r.check.doc)) continue;
    const dv = await store.getDoc({
      workspace,
      subject: ticket.ticket_id,
      doc: r.check.doc as never,
    });
    if (dv?.content.toLowerCase().includes(r.check.needle.toLowerCase())) {
      docs.add(`${r.check.doc}\0${r.check.needle.toLowerCase()}`);
    }
  }
  const relations = new Set(
    (
      await store.listRelations({
        subject: ticketRef(workspace, ticket.ticket_id),
      })
    ).map((r) => r.predicate),
  );
  return {
    fields: {
      work_type: ticket.work_type,
      origin: ticket.origin,
      severity: ticket.severity,
      parent: ticket.parent,
      feature: ticket.feature,
    },
    intake: intakeMap,
    sections,
    docs,
    relations,
    verifyPass: await verifyPassed(store, workspace, ticket.ticket_id),
  };
}

/** The latest parsed `classification` block from the ticket's
 *  triage.json artifacts (newest run wins), or null when absent. */
export async function latestClassification(
  store: Store,
  workspace: string,
  ticketId: string,
): Promise<
  | { kind: 'ok'; value: IntakeClassification }
  | { kind: 'invalid'; error: string }
  | { kind: 'absent' }
> {
  const runs = (await store.listRuns({ workspace, ticket_id: ticketId })).sort(
    (a, b) => b.id.localeCompare(a.id),
  );
  for (const r of runs) {
    const art =
      (await store.getArtifact(r.id, 'triage.json')) ??
      (await store.getArtifact(r.id, `${ticketId}/triage.json`));
    if (!art) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(art.content);
    } catch {
      continue;
    }
    const cls = (raw as { classification?: unknown }).classification;
    if (cls === undefined || cls === null) return { kind: 'absent' };
    const parsed = IntakeClassificationSchema.safeParse(cls);
    return parsed.success
      ? { kind: 'ok', value: parsed.data }
      : {
          kind: 'invalid',
          error: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; '),
        };
  }
  return { kind: 'absent' };
}

// ---------- prompt rendering ----------

/**
 * The compact policy block injected into interview/triage prompts
 * ({{TAXONOMY}} token): what the types mean, which intake fields each
 * demands, and the bug-vs-scope rule. Rendered from the policy table —
 * the prompt can never drift from the code.
 */
export function taxonomyPromptBlock(): string {
  const lines: string[] = [
    `work types: ${TICKET_WORK_TYPES.join('|')}`,
    `origins: ${TICKET_ORIGINS.join('|')}`,
    '',
    'type — direct-create — required intake:',
  ];
  for (const t of TICKET_WORK_TYPES) {
    const p = WORK_TYPE_POLICIES[t];
    const fields = p.intake
      .filter((f) => f.required)
      .map((f) => f.key)
      .join(', ');
    lines.push(
      `- ${t} — ${p.direct_create ? 'direct-create allowed' : 'NEEDS approved scope (rs/board origin or scope-proposal approval)'} — intake: ${fields || 'none'} — ${p.summary}`,
    );
  }
  lines.push(
    '',
    'Bug ≠ scope change: `defect` restores approved behavior (direct-create);',
    '`new-capability` exceeds approved scope → the human must approve a scope',
    'proposal (or the work routes to the board); `mixed` = part defect, part',
    'capability → same gate. severity applies to bugs/security/incidents only.',
  );
  return lines.join('\n');
}
