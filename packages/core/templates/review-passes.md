# Review pass focus blocks — injected into {{PASS_FOCUS}} per pass.

## correctness
Logic errors, edge cases, off-by-ones, nil/null handling, error paths
swallowed, race conditions, incorrect conditionals, broken state
transitions. Trace the data through: does this code do what the TDD says?

## security
Security is a first-class review pass, not a scanner verdict. Look for
injection (SQL/cmd/path/template), authz/authn bypasses, secrets or PII
in logs/responses, unsafe deserialization, SSRF, unvalidated input at
trust boundaries, overly broad permissions, dependency risks,
prompt-injection, and insecure defaults. Every security finding MUST
carry `security_category`
(access-control|injection|secrets|data-exposure|unsafe-deps|
prompt-injection|insecure-defaults), `affected_asset` (the file/endpoint/
secret at risk), `exposure` (who can reach it), and `policy_violated`
(the rule or standard it breaks). The runner fails closed on a security
finding missing them; critical findings block merge/release until
resolved or covered by an owner+expiry exception.

## spec-compliance
The runner already diffed the TDD file-plan vs `git diff --name-only`
mechanically — you don't recheck file lists. YOUR job is judgment:
is every RS AC actually satisfied by the code (not just mapped)? Is
each agent deviation in DEVIATIONS.md justified and minimal — or is a
logged "deviation" really spec drift? Is a file-plan mismatch the
runner flagged a real problem or noise?

## test-gap
Planned cases missing, cases that don't exercise what they claim,
assertion-free tests, missing edge/failure-path coverage, tests that
would pass even if the feature were broken.
