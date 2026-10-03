---
schema: 1
id: wp-070
title: Knowledge base — survey runs, dossiers, entities, embeddings
status: done
status: in-progress
priority: low
depth: deep
repos: []
wave: W7
depends_on: [wp-011]
---

## Description
KB machinery: survey run type (survey.md prompt, SURVEY-* tokens,
product + repo scopes, Playwright crawl optional/graceful) → dossier
sections to DB w/ versioning + human-edit-wins rules; entities +
relations + ontology-lite rows; embeddings: SPIKE FIRST —
onnxruntime-node/transformers.js MiniLM bundled model in a desktop
context; if infeasible, document and implement `local`→`openrouter`
fallback with `off` always functional; prior-art recall (file-overlap +
embedding similarity) → {{PRIOR_ART}}; stale-flag on refresh diff.

## File ownership
`packages/kb/**`, `docs/ADAPTERS.md` or new `docs/EMBEDDINGS.md` (spike
findings backport)

## Acceptance criteria
- [ ] Spike decision documented; chosen path implemented
- [ ] Survey run → dossier rows versioned; human edits survive re-survey
- [ ] PRIOR_ART token populated (degrades to file-overlap when off)
- [ ] semantic.embeddings: off → zero vector code paths execute
