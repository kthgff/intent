# INTELLIGENCE — evidence, retrieval, and continuous alignment

Companion technical design for `PRD.md`. Ratified 2026-10-04 (D37).
This document defines the intelligence layer shared by product discovery,
specification, implementation, review, release, and production learning. The
binding data and wire contracts remain in `SCHEMAS.md`, `DB-SCHEMA.md`,
`SETTINGS.md`, `ADAPTERS.md`, `CONDUCTOR.md`, and `API.md`.

## 1. Product decision

Veto does not build separate "RAG systems" for requirements, code, and logs.
It builds one **evidence plane** with source-specific indexes and a common
retrieval contract. Every generated claim must be traceable to current,
authorized evidence.

The evidence chain is:

```text
goal → board item → requirement/AC → feature/ticket → code/test →
commit/PR → deployment → telemetry/incident → resolution
```

Explicit links written by the workflow are authoritative. Derived links are
stored with provenance, confidence, and verification state. A suggestion at
confidence ≥0.90 may be promoted to `auto-verified`, but it must remain visibly
labeled as automated; lower-confidence links require human verification.

For changes to an existing product, the code/dossier investigation happens
**before** the PRD is drafted. Greenfield work degrades honestly when no code
evidence exists.

## 2. Non-negotiable principles

1. **Hybrid retrieval, never vectors alone.** Exact path/identifier search,
   Postgres full-text search, semantic similarity, explicit relations, and
   structural traversal contribute candidates. A bounded reranker merges them.
2. **Commit-pinned evidence.** Code citations include repository, commit SHA,
   path, line range, symbol, and content hash. A newer default-branch SHA marks
   older evidence stale; it never mutates history in place.
3. **Read the current files before changing them.** Retrieved chunks help plan
   work. Coding/review agents still open the current files and run the real
   build/tests; retrieval output is not a substitute for the worktree.
4. **Permission filtering precedes retrieval.** Project/repository/source ACLs
   are applied before keyword, vector, or graph search, not after results enter
   a prompt.
5. **Untrusted evidence.** Repository text, documents, logs, issue text, and
   incident notes can contain prompt injection. They are quoted as evidence,
   never treated as instructions or authority.
6. **Fail closed on malformed structured output.** Missing citations,
   unauthorized evidence, or an invalid result shape blocks the intelligence
   artifact. No guessed files, links, causes, or coverage.
7. **Hypotheses are labeled.** Drift, impact, release risk, and root-cause
   analysis are findings with evidence and confidence, not declarations of
   correctness. Human gates remain for spec changes, disruptive fixes,
   deployments, and production configuration.
8. **No individual productivity scoring.** Delivery intelligence describes
   system/team bottlenecks and outcomes; it is not a developer ranking system.

## 3. Logical architecture

```text
Sources
  code/git · docs/ADRs · Veto docs/events · tests/CI · deployments
  feedback · logs/traces/metrics · incident resolutions
       │
       ▼
Ingest and safety boundary
  authorize · redact · parse · normalize · fingerprint · content-hash
       │
       ▼
Specialized indexes in Postgres
  FTS · embeddings · code units/symbols · typed relations · time metadata
  raw high-volume telemetry stays in its observability backend
       │
       ▼
Evidence retrieval
  authorize → query plan → candidate searches → graph expansion → rerank
  → freshness check → token budget → cited evidence bundle
       │
       ▼
Consumers
  discovery · PRD quality · impact/design · test planning · implementation
  review · release readiness · alignment findings · incident investigation
```

Postgres + pgvector is sufficient for the first implementation. A separate
vector or graph database requires measured query/scale evidence; it is not an
architectural prerequisite.

## 4. Code intelligence

### 4.1 Ingestion

Immediately after D37 is installed, repository indexing is enabled by default
but configurable. Connecting/adding a project automatically starts the initial
index; every observed default-branch advancement automatically queues an
incremental refresh:

1. Resolve an authorized local clone/worktree and commit SHA.
2. Apply ignore policy: VCS ignores plus generated/vendor/binary/secret and
   configured forbidden-path exclusions.
3. Parse supported languages into `code_units` at symbol/logical-unit
   boundaries. Unsupported or syntactically broken files fall back to bounded
   line chunks and carry `parse_status: fallback`.
4. Record symbols, imports/references, test relationships, content hashes, and
   exact source coordinates. Tree-sitter is the preferred multi-language
   parser; language-specific analysis may enrich it.
5. Write FTS content and optional embeddings. Reuse unchanged content by hash;
   only changed/deleted paths are reindexed.
6. Advance the repository index head atomically only after the new commit is
   complete. Partial indexes are never served as current.

The first release supports symbol definitions/imports and explicit workflow
links. Dependable call-graph and data-flow analysis is a later enrichment; the
system must not imply that embedding similarity proves dependency.

### 4.2 Retrieval

A retrieval request carries project, authorized repos, task kind, subject,
query, optional symbols/paths, source types, commit policy, result/token limit,
and whether stale evidence is acceptable. The service returns a
`retrieval-evidence.json` artifact (SCHEMAS §17).

Ranking combines:

- explicit workflow links and verified relations;
- exact identifiers, paths, error codes, and FTS terms;
- semantic similarity;
- structural neighbors (definition/import/reference/test/dependency);
- recency/freshness and prior validated use;
- task-specific weighting, with the contribution recorded per result.

Every stage receives the smallest useful evidence bundle, not a dump of the
repository. Zero relevant results is a valid, explicit outcome.

### 4.3 Product consumers

- **Discovery/PRD:** existing behavior, constraints, prior implementations, and
  conflicts are investigated before drafting requirements.
- **Design/impact:** likely files/services/APIs/data structures/tests are cited;
  blast radius is a hypothesis until structural/current-file checks confirm it.
- **Test design:** ACs and changed behavior map to proposed unit, integration,
  contract, and end-to-end tests; uncovered ACs remain visible.
- **Implementation/review:** current worktree files are read and commands run;
  code citations make plans and findings inspectable.
- **Organizational knowledge:** "why" queries traverse verified PRD/ticket/PR/
  commit/ADR links before considering inferred relations.

## 5. PRD quality and continuous alignment

The existing mechanical `spec_score` remains a cheap leading indicator. An AI
quality pass adds cited findings for ambiguity, contradiction, missing failure
paths, accessibility, abuse/security, data/privacy, performance, operability,
rollout, observability, rollback, migration, and success measurement. It does
not invent a second opaque score and never auto-approves a PRD. Critical
findings block approval until resolved or explicitly waived with rationale;
moderate and minor findings are advisory.

Continuous alignment compares three evidence sets:

- **Intended:** goals, requirements, ACs, approved PRD/TDD/test plans.
- **Implemented:** current code, commits, PRs, configuration, release contents.
- **Verified/observed:** tests, CI, verification evidence, deployments, and
  production signals.

The output is `alignment-findings.json` (SCHEMAS §18). Findings include missing
implementation evidence, unverified ACs, implementation without linked intent,
likely spec/code drift, and changes affecting previously approved behavior.
They are reviewable suggestions with evidence, confidence, and freshness. RAG
alone cannot prove behavioral equivalence.

Release readiness reuses the same model: deterministic gates (tests, unresolved
findings, migration/rollback checks, required attestations) are truth; AI adds
an evidence-backed risk narrative. The risk narrative cannot turn a failed
gate green.

## 6. Telemetry and incident intelligence

Telemetry intelligence is a post-foundation phase. Veto integrates with an
observability backend; it does not become a raw log warehouse.

### 6.1 Ingest boundary

OpenTelemetry/OTLP is the first production connector. Batch/file/container
connectors are later secondary paths. Before any content is stored, embedded,
or sent to a model:

1. authorize project/source;
2. redact configured secrets, credentials, personal data, and request bodies;
3. normalize variable values while preserving exception class, error code,
   useful frames, service/resource attributes, trace/span ids, version, and
   deployment markers;
4. fingerprint and deduplicate recurring patterns;
5. keep counts/time-series/raw-event locators in the observability backend;
6. embed only sanitized fingerprints, bounded representative samples,
   summaries, and validated incident resolutions.

Structured queries answer "how many/when/which service." Semantic retrieval
answers "have we seen something like this." These are not interchangeable.

### 6.2 Investigation and learning

An incident investigation correlates error signature → trace/span → service/
symbol → commit/PR → ticket/requirement → deployment → prior incident. It emits
ranked hypotheses, disconfirming evidence, and next verification steps in
`incident-investigation.json` (SCHEMAS §19).

When a new or regressed signature crosses its configured count/rate/window
threshold, Veto automatically creates a **draft ticket proposal**. Creating the
actual ticket remains a human-approved action. Creating a
code fix uses the normal ticket pipeline. Deployments and production config
changes always remain behind their existing human/operational controls.

A resolved incident becomes a reusable knowledge record only after a human or
authoritative system supplies the resolution outcome. Recurrence detection may
suggest that a fix failed; it does not silently reopen or modify work.

## 7. Evaluation and operating metrics

Each intelligence capability ships with a versioned golden set. Minimum
offline measures:

- relevant-file/symbol recall at k;
- citation validity and commit freshness;
- exact-identifier recall;
- dependency/test coverage for known changes;
- unauthorized-result count (**must be zero**);
- unsupported-claim rate;
- duplicate/error-cluster precision and recall;
- incident top-k cause recall and time-to-useful-next-step.

Product measures focus on outcomes: spec defects found before implementation,
ACs with verified test evidence, rework from missed requirements, escaped
defects, change-failure/recovery measures, and whether the feature's target KPI
improved. AI scores are never the sole KPI.

## 8. Delivery phases and pushback

### Phase A — foundation (immediate post-launch; not a launch blocker)

- commit-pinned code units, FTS + semantic retrieval, source citations;
- explicit requirement/ticket/PR/commit/test links with provenance;
- code-aware PRD, design/impact, test-plan, implementation, and review context;
- PRD quality findings and retrieval golden-set evaluation.

### Phase B — continuous alignment

- incremental reindex on default-branch change;
- richer structural traversal and change-impact analysis;
- intended/implemented/verified alignment findings;
- evidence-backed release-readiness narrative and feedback clustering.

### Phase C — production learning

- sanitized telemetry connectors, fingerprint/deduplication, similar incidents;
- deployment correlation, root-cause investigation, incident knowledge records;
- recurrence checks and human-approved bug-ticket proposals.

Explicitly rejected for now:

- embedding every file chunk or every log event without deduplication;
- introducing a graph/vector database before Postgres is measured insufficient;
- treating model-generated links, readiness scores, drift, or root cause as
  verified truth;
- autonomous production changes or auto-generated tickets without review;
- cross-project learning that bypasses project/repository authorization;
- individual developer rankings derived from AI or delivery telemetry.

## 9. Shared-chat proposal disposition

This matrix prevents attractive ideas from becoming duplicate subsystems or
quiet scope. "Existing" means the current product contract already owns the
job; D37 strengthens its evidence, not its page count.

| Proposal | Decision |
| --- | --- |
| Codebase RAG | **Accepted as Phase A hybrid code intelligence**, not vector-only RAG (§4) |
| Log RAG | **Accepted as Phase C telemetry/incident intelligence**, after redaction + fingerprint/dedupe; raw events stay in the source backend (§6) |
| Unified lifecycle / software-delivery digital twin | **Accepted as the evidence plane and continuous alignment**, but findings are hypotheses rather than a claim that the model perfectly mirrors runtime behavior |
| Product discovery agent | **Existing:** board synthesis + interview/triage wizard; D37 adds current-product evidence before questions/drafting |
| PRD quality evaluator | **Accepted Phase A:** deterministic `spec_score` plus cited AI findings; critical findings block until resolved/waived, moderate/minor are advisory; rejected opaque auto-approval score |
| Feature dependency / impact analyzer | **Accepted Phase A/B:** exact, semantic, explicit, and structural evidence with blast-radius uncertainty |
| Intelligent backlog prioritization | **Limited:** AI may present evidence and explain existing priority factors; it may not invent an opaque priority or silently reorder committed work |
| AI software architect | **Existing:** design-QA/TDD stage; D37 grounds alternatives and file/API/data impact in current evidence |
| Multi-agent development | **Existing in bounded form:** specialized stage/review agents coordinated by the conductor; rejected unrestricted agent swarms or self-granted tools/permissions |
| AI code/security review | **Existing:** specialist review plus deterministic tests, sanitizer, and tooling; D37 improves citations/traceability |
| AI test designer | **Existing and strengthened:** `test.md`/coverage matrix gains code-aware impact and uncovered-AC evidence |
| UI/UX auditor and prototypes | **Partly existing:** screenshots/Playwright survey and design review; visual regression/accessibility auditing is Phase B evidence work, not an autonomous design authority |
| Root-cause investigator | **Accepted Phase C** with ranked hypotheses, disconfirming evidence, next checks, and human-controlled actions |
| Intelligent release readiness | **Accepted Phase B:** hard gates remain truth; AI contributes only an evidence-backed risk narrative |
| Customer-feedback intelligence | **Existing ingress, Phase B analysis:** capture/board feedback is current; clustering and suggested links/work are deferred |
| Requirements-to-code drift | **Accepted Phase B** as intended/implemented/verified alignment findings |
| Engineering delivery intelligence | **Existing metrics, strengthened:** outcome and bottleneck analysis only; individual developer scoring is explicitly rejected |
| Organizational knowledge agent | **Existing dossier, strengthened:** evidence plane adds verified history and source navigation so "why" answers do not manufacture rationale |
