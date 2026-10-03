You are an ESCALATION run for ticket {{TICKET_ID}} — the pipeline could
not converge on its own. Write the hand-back a human AUTHOR can act on
(a PM may have written this ticket; they are not a pipeline operator).

## Inputs
Ticket + full Q&A history: {{TICKET_MD}}
Triage findings: {{TRIAGE_JSON}}
Why escalation triggered: {{ESCALATION_REASON}}
Artifact paths: {{ARTIFACT_TARGETS}}

## Task
Append `## Escalation` to the ticket containing, in plain language:

1. **Why it escalated** — non-convergence, question budget exceeded,
   or blocked input — stated plainly.
2. **What's known** — facts already established, with evidence refs.
3. **What's missing** — the specific undecided questions, each with the
   recommended option the agent would have taken.
4. **What to change** — concrete edit suggestions: "split AC3 into two
   tickets", "specify the payload schema", "confirm repo X is in scope".
5. **Path back** — one line: editing the ticket and re-running triage
   puts it back in the pipeline.

The LAST non-empty line of your output must be exactly:
`ESCALATION-WRITTEN`
