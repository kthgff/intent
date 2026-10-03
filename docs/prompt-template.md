You are working on ticket {{TICKET_ID}} in the `{{REPO_NAME}}` repository.
The git branch `{{BRANCH}}` has already been created and checked out for you.
Do all of your work on this branch. Do not switch branches.

## Sprint context

{{SPRINT_MD}}

## Ticket

{{TICKET_MD}}

## Instructions

1. Read the ticket above carefully. Implement the change described in
   "Description" until every item in "Acceptance criteria" is satisfied.
2. Follow this repository's existing conventions, style, and patterns. Check
   for repo-specific agent instructions (AGENTS.md, .devin/, .cursor/, etc.)
   and obey them.
3. Run the repository's test suite and linter. Fix anything your change
   breaks. Do not disable or delete failing tests to make the suite pass.
4. Commit your work on `{{BRANCH}}` with a clear commit message that
   references {{TICKET_ID}}.
5. Push the branch and open a pull request with `gh pr create`. Title the PR
   "{{TICKET_ID}}: <ticket title>" and in the body summarize what changed and
   how you verified it. Do NOT merge the PR.
6. As the final line of your response, print exactly:

   PR: <pull request url>

If you cannot complete the ticket — unclear requirements, missing access,
failing pre-existing tests that block you — explain why and print the
following as the final line instead:

   BLOCKED: <one-line reason>
