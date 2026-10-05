---
schema: 1
id: wp-150
title: Security review dimension — categories, per-finding fields, risk-tiered enforcement
status: done
priority: medium
depth: standard
repos: []
wave: W20
depends_on: [wp-148]
---

## Description
PRD §15.8 security block. `review_findings` gains security fields
(security_category, affected_asset, exposure, policy_violated);
security taxonomy (access control, injection, secrets, data exposure,
unsafe deps, prompt-injection, insecure defaults). Risk-tiered
enforcement config: low → baseline scans + standard review; medium →
targeted checks + normal approval; high → dedicated security analysis
+ designated reviewer; critical → blocks merge AND release until
resolved or tightly-controlled exception (with owner + expiry).
Security review also runs at **design time**: threat-model section in
the TDD template + design-time security gate for sensitive-scope
changes. Scanner results (gitleaks etc.) map to findings, never to
silent pass/fail — disposition stays human/policy.

## File ownership
`packages/conductor/src/review/security.ts`, `packages/lints`,
`packages/core` security enums (wp-131), `packages/core/templates`
TDD threat-model section

## Acceptance criteria
- [ ] Security findings carry the full field set
- [ ] Critical severity blocks merge + release gates (fail-closed)
- [ ] Design-time security gate fires on sensitive scope
- [ ] Exceptions require owner + expiry + rationale

## Contract change
None beyond wp-131.
