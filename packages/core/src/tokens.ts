/**
 * PromptToken union — every {{TOKEN}} in ADAPTERS.md's token table.
 * Prompt templates consume these; the renderer injects them per stage.
 */

export const PROMPT_TOKENS = [
  'TICKET_ID',
  'TICKET_MD',
  'TICKET_DIR',
  'TICKETS_DIR',
  'CONTEXT_MD',
  'REPO_NAME',
  'REPO_NAMES',
  'REPO_CARDS',
  'REPO_PATH',
  'CARD_PATH',
  'ARTIFACT_TARGETS',
  'DEPTH',
  'DOSSIER',
  'PRIOR_ART',
  'SPEC_LINT',
  /** Spec docs — addendum names (wp-132): RS = Requirements
   *  Specification (rs.md), VS = Verification Specification (vs.md). */
  'RS_MD',
  'TDD_MD',
  'VS_MD',
  'DIFF',
  'DEVIATIONS_MD',
  'FINDINGS_JSON',
  'FINDING',
  'THREAD_JSON',
  'BRANCH',
  'CI_FAILURE_LOGS',
  'CYCLE',
  'MAX_CYCLES',
  'PR_COMMENTS_JSON',
  'PR_URL',
  'MERGED_SHA',
  'DOC_PATH',
  'LINT_ERRORS',
  'SCHEMA_REF',
  'ESCALATION_REASON',
  'TRIAGE_JSON',
  'SEED_TEXT',
  'NEW_ID',
  'SPLIT_MAX_CHILDREN',
  'SURVEY_BUDGET',
  'APP_URL',
  'DOC_PATHS',
  'SCREENSHOT_DIR',
  'EXTRA_SOURCES',
  'PRIOR_DOSSIER',
  'SEMANTIC_OUT',
  'DOSSIER_OUT',
  'SCOPE',
  'SCOPE_NAME',
  'PASS_NAME',
  'PASS_FOCUS',
  'DISMISSAL_CAP',
  'CAPABILITY_NOTES',
  'RAW_ISSUES_JSON',
  'REPO_MAP',
  /** Human feedback comment carried into a doc revision run
   *  (S-06 doc_feedback → the re-run's prompt). */
  'FEEDBACK',
  /** Addendum-stage inputs (wp-132): `RELEASE_MD` is the frozen
   *  manifest + delivery/outcome evidence bundle injected into the
   *  `retro` stage (DELIVERY §7); `BRIEF_INPUTS` is the discovery
   *  synthesis bundle (board statements, decisions, scope) the
   *  `solution-brief` draft consumes (producing stage lands with the
   *  discovery wps — wp-144/145). */
  'RELEASE_MD',
  'BRIEF_INPUTS',
  /** Authorized, cited `retrieval-evidence.json` slice (D37, wp-110) —
   *  the bounded evidence bundle injected into code-aware stages
   *  (prd, design, testplan, implement, review, alignment, incident).
   *  Empty → an explicit "no relevant evidence" block, never a silent
   *  empty string (ADAPTERS token table). */
  'EVIDENCE_BUNDLE',
] as const;

export type PromptToken = (typeof PROMPT_TOKENS)[number];

/** token → rendered text substitutions applied to a template. */
export type TokenValues = Partial<Record<PromptToken, string>>;
