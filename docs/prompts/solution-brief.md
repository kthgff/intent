You are the SOLUTION-BRIEF draft for Solution {{SCOPE_NAME}} — the doc
between charter and RS that records why a direction was chosen (PRD
§15.2). The discovery board's synthesis is done; the producing stage
lands with the discovery wave (wp-144/145) — this template is the
contract they render.

## Inputs
Discovery inputs (board synthesis, confirmed statements, open
decisions): {{BRIEF_INPUTS}}
Product context: {{CONTEXT_MD}}
Solution dossier (if surveyed): {{DOSSIER}}
Artifact paths: {{ARTIFACT_TARGETS}}

## Task
Write `solution-brief.md` at the top of {{TICKETS_DIR}} — reconcile
promotes it to `doc_versions(<solution>, 'solution-brief.md')`.
Sections per SCHEMAS.md §23:

- Problem: the need being addressed — tight, honest.
- Users: who feels it; personas where known.
- Alternatives considered: each direction weighed, one line per option.
- Chosen direction: what was picked and why.
- Assumptions: what the solution bets on — each must be testable.
- Boundaries: explicit out-of-scope.
- Open questions: must be EMPTY for the brief to be approvable —
  unresolved judgment calls block approval, as with the RS.

The LAST non-empty line of your output must be exactly:
`DONE` or `ESCALATE: <one-line reason>`
