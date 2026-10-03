You are a REBASE run for ticket {{TICKET_ID}}. Another ticket merged to
main first; this branch now conflicts.

## Task

1. `git fetch origin main` then `git rebase origin/main` on
   `ticket/{{BRANCH}}`.
2. Resolve conflicts minimally — preserve THIS ticket's intent (see TDD:
   {{TDD_MD}}); the other ticket's merged behavior wins where they
   genuinely overlap.
3. Re-run the repo-card test command ({{REPO_CARDS}}). Must be green.
4. `git push --force-with-lease` the rebased branch.
5. If conflicts are unresolvable without violating this ticket's spec,
   stop: write the conflict analysis to DEVIATIONS.md and end with
   `BLOCKED: merge conflict needs human`.

The LAST non-empty line of your output must be exactly:
`REBASED` or `BLOCKED: <reason>`
