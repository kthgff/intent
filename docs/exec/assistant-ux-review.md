# Assistant UX Review — interview runs, mode confusion, and the relief machinery

Status: review 2026-10-08. Scope: the Board Assistant (`conductor/assistant`,
`api/board-assistant`, `ui/board-canvas/AssistantPanel`) and the interview
engine it rides (`conductor/interview`). Binding specs reviewed:
`PRD.md` §15.9, `design/BOARD-CHAT-PRD.md`, `design/BOARD-CHAT-TDD.md`,
`API.md`, `SCHEMAS.md`, `DB-SCHEMA.md`.

Decisions captured (5 questions, all answered): **explicit UI mode** for
pending questions · **one live mic + park/resume** for runs · **domain
errors in-thread** · **full hand-off bundle** · **deterministic Q&A floor**.

## 1. Summary

The "can't start another interview" message is a symptom, not the disease.
Three mechanics combine into the reported pain:

1. **Every freeform word is a hostage.** While a run has an `asked`
   question, `postMessage` routes ALL non-command text to `submitAnswer` —
   extraction, slot binding, and `create-item` proposal drafts included.
   "Why are you asking this?" becomes a board sticky and a ledger
   statement (`turn.ts:343-426`).
2. **The relief machinery exists but is unreachable.** `resolveQuestion`
   already supports `skipped`/`unanswerable` (`planner.ts:336`) and is
   already REST-exposed for standalone sessions
   (`api/src/discovery.ts:472`); `pauseSession`/`resumeSession` exist
   (`session.ts:510`). The assistant surface wires none of it.
3. **Lifecycle is all-or-nothing.** `startRun` hard-conflicts on any
   active branch (`runs.ts:80`), and `endRun` is the only exit — merge or
   nothing. Branch statuses are `active|merged|abandoned`; there is no
   "hold".

The chosen direction: **runs are modes, not locks** — the pending
question becomes a distinct card that owns answers; the composer is
always freeform; starting a new run parks the old one instead of
erroring; engine refusals post in-thread with a next step.

## 2. Issue inventory

| # | Sev | Symptom | Root cause | User impact |
|---|-----|---------|------------|-------------|
| 1 | blocker | Any text during a pending question is consumed as the answer — extraction, slot binding, proposal drafts | `turn.ts:343-426` (`activeRunPending` → `submitAnswer`); `runs.ts:206-215` | Side questions corrupt the ledger and spawn garbage proposals; interview can't be interrupted |
| 2 | high | **Ghost question after run end:** an `asked` candidate survives `mergeBranch`; the NEXT freeform message is eaten as its answer (branch=null) | `endRun`/`mergeBranch` never resolve `asked` candidates; `pendingQuestion` falls back to `asked[0]` (`planner.ts:416`); `turn.ts:344` unbranched lookup | The hijack persists *after* the interview is over — worst variant of #1 |
| 3 | high | `run 'run-N' is already active` 409 on `/interview`, `/expand`, chip | `runs.ts:75-84` single-active guard → `InterviewError(conflict)` → 409 | Dead-end error; only recovery is undocumented `/interview end` |
| 4 | high | No way to skip or say "I can't answer" a question | `resolveQuestion` supports `skipped`/`unanswerable` (`planner.ts:336-386`, `enums.ts:1088-1094`) but no assistant command/button calls it | Must pollute an answer or end the whole run |
| 5 | high | No pause/park for runs | `INTERVIEW_BRANCH_STATUSES` lacks a hold state (`enums.ts:1072-1077`); `pauseSession` pauses the whole thread and isn't wired | Can't put an interview down to do something else |
| 6 | medium | Engine errors surface as 8-second toasts, gone before actionable | `call()` → `ApiError` (`board-assistant.ts:121-133`) → `onError` → `setToast` (`AssistantPanel.tsx:184`, `IdeaBoard.tsx:52,179-181`) | Refusals are transient, unexplained, non-actionable |
| 7 | medium | No mode visibility: pending question is plain thread text; only cue is the composer placeholder | `AssistantPanel.tsx:513-517`; PRD R4 "no question cards" | Users don't know they're answering vs. chatting; dictation slips become answers |
| 8 | medium | Freeform is dead without a provider — even pure read questions ("what's missing?") | `NO_PROVIDER_REPLY` short-circuit (`converse.ts:22-24,117-119`) | Assistant refuses data it already computes (`boardCoverage`, `evaluateReadiness`) |
| 9 | medium | `Run /interview` chip still offered during an active run — invites the 409 | `suggestChips` ignores `active_run`/`pending` (`skills.ts:55-83`) | The UI leads users into the error |
| 10 | medium | Multiplayer ambiguity: shared thread, but a pending question isn't attributed; anyone's freeform becomes the answer; anyone can end anyone's run | `active_run`/`pending_question` carry no `created_by` display; `endRun` unguarded (`AssistantPanel.tsx:335-345`) | Teammates hijack each other's interviews silently (R9 shares the thread; it shouldn't share the mic) |
| 11 | low | Turn pipeline is non-transactional: two rapid sends (two tabs/users) can interleave — double answer or answer-order 409 | `postMessage` sequential writes, no per-session serialization (`turn.ts:172-461`); `busy` is per-client | Corrupt ordering under concurrent use |
| 12 | low | Comment/spec drift: header says "1. pending → 2. /skill"; code runs `/skill` first (correct escape behavior, undocumented) | `turn.ts:1-11` vs `:194-317`; TDD "turn pipeline" lists pending first | Maintainers misread precedence |
| 13 | low | Transcript loaded whole on every panel GET/SSE refresh | `panelState` → `transcript()` unpaginated (`thread.ts:182`); TDD budget promised 50-msg pages | Long threads get slow; every event re-reads all |
| 14 | low | Batch accept exists, batch reject doesn't — N pending rejects = N clicks | `board-assistant.ts:253-311` | Proposal triage friction |
| 15 | low | `/expand` pill calls `POST /runs` directly — the invocation isn't an attributed user turn (unlike `/interview` via messages) | `AssistantPanel.tsx:202-214` | Audit gap on the shared thread |
| 16 | low | No "working" indicator: composer disables while busy, assistant reply only appears post-write | `AssistantPanel.tsx:91,197`; no streaming by design (PRD non-goal) | Long provider turns look frozen |
| 17 | low | `END_PHRASES` ("done", "that's all") end the run on whole-text match — can't be used as a literal answer | `turn.ts:70-93,322-340` | Resolves itself under the card UI (phrases apply to composer only) |
| 18 | low | `/expand` scope recovered by parsing `[run scope]` system markers | `turn.ts:148-166` | Brittle string contract inside durable data |

## 3. Recommended design — "runs are modes, not locks"

### 3.1 The fix (chosen)

**A. The pending question becomes a card.** When a run's branch has an
`asked` candidate, the panel renders a question card above the composer:
question text, its own answer field, and four actions — **Answer**,
**Skip**, **Can't answer**, **Pause run**. The card owns answers
exclusively. The main composer is *always* freeform/chat and never
feeds `submitAnswer` implicitly.

- Turn router: the pending-question interception is deleted. Freeform →
  `converse` (or the deterministic floor, §3.4) regardless of run state.
- Answers arrive explicitly: extend `POST …/assistant/messages` with an
  optional `answer_to: <question_id>` field (zod-strict). `answer_to`
  present → `submitAnswer`; absent → command/freeform. One endpoint,
  backwards compatible. (Alternative: `POST …/assistant/questions/:id/answer`
  mirroring `discovery.ts` — slightly more REST-orthodox; either is fine,
  pick one in wp-168.)
- `?`-terminated composer text while a card is open stays freeform — no
  special-casing needed; the card is the authority on what counts as an
  answer. This is the fail-closed property: **nothing is ever guessed as
  an answer**; the worst case of the new model is a side question the
  assistant answers in chat, never ledger pollution.

**B. One live mic, many parked runs.** Add `'parked'` to
`INTERVIEW_BRANCH_STATUSES` (core enum only — `interview_branches.status`
is TEXT with no CHECK, `0001_init.sql:854`; **no migration**).

- `startRun` no longer throws on an active run — it parks it:
  `parkRun(active)` sets branch `parked`, posts a system marker
  ("run-1 parked — resume anytime"), then opens `run-N` normally.
  The 409 becomes unreachable from the assistant surface.
- `resumeRun(branch)`: parked → `active` (auto-parking whatever is
  live); its `asked` question re-surfaces on the card. `mergeBranch`
  accepts `parked` (its guards refuse only `merged`/`abandoned`,
  `branches.ts:130-136`) — ending a parked run is legal.
- `panelState` gains `parked_runs: string[]`; parked runs render as
  resumable cards/chips ("Resume run-1 · 4 answers in").
- The asked question on a parked run stays `asked` — it re-asks on
  resume. It must be **scoped out** of all pending lookups for other
  branches/null (see bug fix below).

**C. Wire the existing relief verbs.** Card buttons and composer
commands alike: `/skip` → `resolveQuestion('skipped')`,
`/cant-answer` (and "I don't know" phrasing inside the card flow, not
the composer) → `'unanswerable'`. Both already defer the slot and
never re-ask — this is a routing change, not engine work.
`DiscoverySession` already exposes skip via REST; the board surface
catches up.

**D. Domain errors post in-thread.** `postMessage` catches
`InterviewError` → appends an assistant message with the refusal + a
concrete next step ("run-2 is parked — say 'resume run-2' or use the
Resume card"), returns 200. Zod 400s, board 404s, and transport failures
keep their current path (they're API contract failures, not
conversation). Stale-proposal accepts and answer-order refusals become
self-explanatory.

**E. Kill the ghost question.** `endRun` resolves any `asked` candidate
on the branch as `'skipped'` (reason `run ended`) before merge. Plus the
engine-level fix: `pendingQuestion(sessionId, branch)` drops the
`?? asked[0]` fallback whenever `branch` is explicitly passed
(`planner.ts:416`) — an asked question may only resolve against the
branch that asked it. This also prevents parked-run questions from
leaking into unbranched lookups.

**F. Surface run state.** Panel header shows "Interviewing — run-3 ·
goals" (or "Paused — run-1 parked"); `suggestChips` suppresses
`Run /interview` while a question is pending and emits `Resume run-N`
when parked runs exist (new chip id). `aria-live` announces question
cards distinctly.

### 3.2 Alternatives considered

| Approach | Why not chosen |
|---|---|
| Intent classification (answer vs. side-question in one input) | Adds a guessing layer to a fail-closed system. Heuristics (`?`, question words) misfire on answers containing questions; a model classifier still misroutes the tail, and every misroute toward `submitAnswer` is ledger pollution. Explicit UI state is classification with zero error rate. Viable as a later *assist*, never as the router. |
| Auto-park on any non-command text | Legitimate answers would park the run every turn — destroys interview flow. |
| Escape hatches only (`/answer`, `?` prefix) | The hijack default survives; users lose text until they learn the escapes. Keep `/answer` as a secondary convenience, not the mechanism. |
| Multiple concurrent active runs | The branch machinery supports it, but "which question am I answering?" load lands on the user and merge conflicts multiply. Parked runs deliver 90% of the value (interruption without loss) at 10% of the complexity. Revisit if multi-stakeholder boards demand it. |
| Session-level pause (`pauseSession`) | Pauses the whole shared thread — freeform chat freezes too. Wrong granularity; the branch is the unit that runs. |

### 3.3 Spec amendments required (backport rule)

| Doc | Amendment |
|---|---|
| `BOARD-CHAT-PRD.md` R4 | "Pure conversation — **no question cards**, no option chips" → carve out the pending-question card: one card, no answer-option chips. Also fix the pause/resume line (`:208-210`) — now literally true at branch granularity. |
| `BOARD-CHAT-TDD.md` "turn pipeline" (`:201-228`) | Rewrite ordering: `answer_to` → submitAnswer; `/skill` → runs/skills; freeform → converse. The interception rule is removed. |
| `BOARD-CHAT-TDD.md` REST table (`:291-302`) | Add `answer_to` on messages (or the questions route), `POST …/runs/:branch/park`, `…/resume`, `parked_runs` on GET. |
| `API.md` | Same route additions. |
| `SCHEMAS.md` | `INTERVIEW_BRANCH_STATUSES += 'parked'`; endRun resolves `asked` → `skipped`; `pendingQuestion` strict branch scoping. |
| `PRD.md` §15.9 | Verify the branch-status enumeration there; amend to include `parked` if enumerated. |
| `TRACKER.md` | Decision-log entry: explicit-UI routing + one-live-mic model + core enum change rationale. |

**`packages/core` changes:** yes, minimal and justified —
`INTERVIEW_BRANCH_STATUSES += 'parked'` (`enums.ts:1072`) and any core
type that mirrors branch status (check `schemas.ts` row schemas). No DB
migration (status column is unconstrained TEXT). No `ProposalOp` changes.

## 4. Broader enhancements

| Enhancement | Rationale | Effort |
|---|---|---|
| Deterministic Q&A floor: known-shape reads ("what's missing?", "are we ready?", "what changed?") answered from `evaluateReadiness`/`boardCoverage` when no provider — and fast-pathed even with one | #8: the assistant refuses questions it already has the data for; extends R10's degrade-loudly rule | S |
| In-thread domain errors (§3.1-D) | #6: refusals become durable, actionable turns | S |
| Ghost-question + strict `pendingQuestion` scoping (§3.1-E) | #2: latent correctness bug independent of the redesign | S |
| Chip suppression during pending/asking + `Resume run-N` chip | #9: stop inviting the conflict; expose parked state | S |
| Batch reject route (`/proposals/reject {ids}`) | #14: parity with batch accept for triage | S |
| Transcript pagination (`after` seq, 50-msg pages per TDD budget) | #13: unpaginated full load every refresh | S |
| Per-run attribution: card shows "waiting on {created_by}'s answer"; end/park restricted or at least attributed on shared threads | #10: shared thread ≠ shared mic (R9-compatible: any member may still act, but attribution makes it honest) | M |
| Turn serialization: single-flight per session (in-process mutex or `answer-order` retry → in-thread refusal) | #11: multi-tab/multi-user races produce double answers | M |
| "Why this question" on the card — `scores` already carries impact/uncertainty/relevance (`planner.ts:52-56`); `DiscoverySession` already renders this | Cheap explainability win; matches the standalone surface | S |
| `/skip`, `/cant-answer`, `/pause`, `/resume` composer commands mirroring card buttons | Parity for keyboard/dictation users | S |
| `/expand` invocation through the message path for attribution parity | #15: audit consistency | S |
| End phrases scoped to composer only (card answers exempt) | #17: "done" must stay a valid answer | S |
| Optional refinement, later: `?`-suffix composer text during an open card → side-question fast path with an in-thread "answered as chat, not as the question" note | Thin assist on top of explicit routing — safe because the card remains authoritative | S |

## 5. Work packages

| WP | Title | Scope | Depends |
|----|-------|-------|---------|
| wp-168 | Assistant UX contracts | `INTERVIEW_BRANCH_STATUSES += 'parked'`; `AssistantPanelState.parked_runs`; `answer_to` field (or questions route); chip id `resume-run`; spec amendments per §3.3; TRACKER row | — |
| wp-169 | Run lifecycle engine | `parkRun`/`resumeRun`; `startRun` auto-park (delete the 409); `endRun` resolves `asked`; `pendingQuestion` strict-scope fix; `/skip`/`/cant-answer`/`/pause`/`/resume` routing; in-thread domain-error replies | wp-168 |
| wp-170 | Assistant API surface | park/resume endpoints; `answer_to` handling; `parked_runs` on GET; error-in-thread mapping; SSE hints unchanged | wp-168, wp-169 |
| wp-171 | Question card + parked-run UI | Card component (answer field, Skip / Can't answer / Pause / Resume / End); parked-run cards; run-state header; chip suppression + resume chip; aria-live + focus; end-phrase scoping | wp-168, wp-170 |
| wp-172 | Deterministic Q&A floor | Known-read intent map → `evaluateReadiness`/`boardCoverage` replies; keep model-required reply for action requests | wp-169 |
| wp-173 | Hardening + closeout | Batch reject; transcript pagination; turn single-flight; "why this question"; `/expand` attribution; full docs backport + e2e cases | wp-169–172 |

Sequenced 168→173; wp-171 and wp-172 may parallelize once wp-170 lands.
Estimated total: ~2 medium tickets (169, 171), the rest small.

## 6. Test matrix

| Area | Cases |
|---|---|
| `pendingQuestion` scoping | asked-on-branch-A invisible to branch-B and null lookups; unbranched asked still resolves; no `asked[0]` fallback leak |
| Park/resume | `startRun` auto-parks active run (no throw); parked branch excluded from `active_run`; resume restores the same `asked` question; merge legal from `parked`; run numbering continues (`run-N` by count, existing convention) |
| Ghost question | `endRun` with an open `asked` → candidate `skipped`, next freeform is chat not answer |
| Answer routing | `answer_to` → `submitAnswer` + proposals; absent → converse even with pending card; `answer_to` unknown id → in-thread refusal, not 500 |
| Skip verbs | `/skip` and card Skip → `skipped` + slot `deferred` + system marker; `/cant-answer` → `unanswerable`, never re-asked (`computeEligibility` NON_REASKABLE) |
| Domain errors in-thread | stale accept, answer-order, merged-branch end → assistant message + 200; zod/404 still throw to `ApiError` |
| Deterministic floor | no-provider "what's missing?" → coverage reply; action request → model-required reply; provider path unchanged |
| Chips | no `Run /interview` while pending; `Resume run-N` while parked exists; `synthesize` still stripped when route isn't live |
| UI | card renders on `pending_question`; answer submits via `answer_to`; Skip/Pause/Resume wired; composer freeform during card; aria-live announces card; composer "done" during card = answer, not end |
| e2e | mid-run side question produces zero statements/proposals; end-run leaves no `asked` residue; parked resume continues the same question; two rapid sends don't double-answer |

## 7. Risks and non-goals

- **Marker parsing debt** (`[run scope]`, `[run parked]`): acceptable for
  v1.5 consistent with existing convention; flag for a real metadata
  column if a third marker appears.
- **Single-flight turns** may need a store-level guard eventually
  (multi-replica API); v1.5 ships the in-process mutex and honest
  refusals.
- **No streaming, no concurrent asking runs, no private branches** —
  unchanged non-goals.
- **Dictation note**: the composer is `DictationField`; the card's
  answer field should support dictation too, but the mic must never
  write into the wrong box — the mode separation makes this safer, not
  riskier.
