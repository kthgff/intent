---
schema: 1
id: wp-110
title: Evidence foundation — commit-pinned code index and hybrid retrieval
status: todo
priority: high
depth: deep
repos: []
wave: W13
depends_on: [wp-090, wp-091, wp-092, wp-100]
---

## Description

Implement D37 Phase A's shared evidence foundation from
`INTELLIGENCE.md` §§1–4. Index configured repositories at an authorized commit
SHA into symbol/logical code units with bounded fallback chunks, FTS,
embeddings, and structural edges. Incremental scans reuse content hashes and
atomically promote a complete `repo_indexes` head; partial/failed heads are
never current.

Implement permission-filtered hybrid retrieval (explicit links, exact/path,
FTS, semantic, bounded structural expansion, freshness, rerank) and emit the
fail-closed `retrieval-evidence.json` contract. Add `{{EVIDENCE_BUNDLE}}`,
repository-index API/status SSE, and a versioned golden-set harness.

## File ownership

`packages/core/**`, `packages/store/**`, `packages/kb/**`,
`packages/conductor/**` (index scheduling only), `packages/api/**`,
`packages/prompts/**`, `docs/EMBEDDINGS.md`

## Acceptance criteria

- [ ] Supported source files index at symbol/logical-unit boundaries; an unsupported or broken file uses bounded `parse_status: fallback` chunks
- [ ] Code evidence records workspace, repo, commit SHA, path, lines, symbol, content hash, and freshness
- [ ] Changed-SHA indexing reuses unchanged content hashes and promotes the new head atomically; failed/partial heads are not served as current
- [ ] Authorization is applied before every retrieval strategy; a cross-project/repo leakage fixture returns zero unauthorized rows
- [ ] Exact identifier/path, FTS, semantic, explicit-link, and structural candidates merge into one bounded result set with per-strategy scores/why
- [ ] Malformed or uncited code results fail closed; zero relevant results is a valid explicit artifact
- [ ] `semantic.embeddings: off` preserves exact/FTS/structural retrieval
- [ ] Golden-set report stores relevant-file/symbol recall@k, citation validity/freshness, exact recall, unsupported-claim proxy, latency, and unauthorized-result count
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass

## Test plan

- Fixture repo with two commits: add/change/delete symbols and verify head
  promotion, reuse, stale historical citation, and deleted-path handling.
- Query fixtures for exact symbol, synonym/semantic phrase, structural test
  neighbor, zero result, embeddings-off degradation, and token/result caps.
- ACL fixture with two projects containing deliberately similar code; assert no
  candidate or serialized artifact crosses authorization.
- Corrupt parser/embedding/index jobs; assert fallback or failed head without
  partial-current state.

## Definition of Done

- [ ] DB migration and core schemas match `DB-SCHEMA.md`/`SCHEMAS.md` §17
- [ ] Index/retrieval diagnostics contain refs and counts but no source secrets
- [ ] Golden-set baseline committed and documented; unauthorized count is zero
- [ ] Relevant D37 tracker row remains linked to this work package

