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
  // ---------- chat-to-edit (interview edit mode, s-01 D25) ----------
  /** Chat-edit session id (cs_*) — also selects the interview-edit
   *  template when present on an `interview` run. */
  'EDIT_SESSION',
  /** Target doc kind under edit (ticket.md / rs.md / tdd.md / vs.md / …). */
  'EDIT_TARGET',
  /** The human's edit request for this turn. */
  'EDIT_MESSAGE',
  /** Current content of the target doc — the run diffs against it. */
  'TARGET_DOC',
  /** Prior turns of the session, serialized (user/assistant lines). */
  'SESSION_LOG',
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
  /** Design-artifact stage inputs (wp-149): `MOCKUP_JSON` is the
   *  current component tree handed to the `mockup` stage for editing
   *  (empty on first draft); `MOCKUP_MODE` selects the generator mode
   *  (compose|screenshot|sketch|states); `DESIGN_SYSTEM_JSON` is the
   *  mined component-token bundle the generator must consume so screens
   *  look native; `DESIGN_SYSTEM_SOURCE` names the repo the
   *  `design-ingest` stage mines. */
  'MOCKUP_JSON',
  'MOCKUP_MODE',
  'DESIGN_SYSTEM_JSON',
  'DESIGN_SYSTEM_SOURCE',
] as const;

export type PromptToken = (typeof PROMPT_TOKENS)[number];

/** token → rendered text substitutions applied to a template. */
export type TokenValues = Partial<Record<PromptToken, string>>;
