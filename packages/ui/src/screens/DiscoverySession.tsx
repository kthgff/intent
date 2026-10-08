import type { InterviewSessionRow } from '@veto/core';
/**
 * Discovery session — the §15.9 wizard surface (wp-147).
 *
 * One screen per Interview Orchestrator session: the three input modes
 * (conversation / guided choices / bulk paste — switchable mid-session
 * without loss, one session state), the question card with "why this
 * question" planner provenance, slot-progress as state chips (never a
 * percentage), and the live Understanding Panel sidebar (SSE-driven).
 * Paused sessions resume through the knowledge-diff briefing modal.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type InterviewSessionDetail,
  type ResumeBriefing,
  type Understanding,
  client,
} from '../api';
import {
  ConfirmDialog,
  Empty,
  ErrorBox,
  Loading,
  Modal,
  StatusBadge,
} from '../components';
import {
  INPUT_MODES,
  type InputMode,
  briefingLines,
  questionWhy,
  slotStateLabel,
  splitBulkAnswers,
} from '../discovery';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectPath } from '../project';
import UnderstandingPanel from './UnderstandingPanel';

export default function DiscoverySession() {
  const { ws = '', session = '' } = useParams();
  const detail = useLoad(
    () => client.discoverySession(ws, session),
    [ws, session],
  );
  const [understanding, setUnderstanding] = useState<Understanding | null>(
    null,
  );
  const [understandingError, setUnderstandingError] = useState<unknown>(null);
  const [answer, setAnswer] = useState('');
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<ResumeBriefing | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<[number, number] | null>(
    null,
  );

  const loadUnderstanding = useCallback(() => {
    client
      .understanding(ws, session)
      .then((u) => {
        setUnderstanding(u);
        setUnderstandingError(null);
      })
      .catch(setUnderstandingError);
  }, [ws, session]);

  const reload = useCallback(() => {
    detail.reload();
    loadUnderstanding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.reload, loadUnderstanding]);

  useEffect(() => {
    loadUnderstanding();
  }, [loadUnderstanding]);

  // Live panel — SSE `interview_updated` hints re-read durable state.
  useStreamRefresh(reload, ['interview_updated']);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <Empty />;

  const d: InterviewSessionDetail = detail.data;
  const s: InterviewSessionRow = d.session;
  const mode = (s.mode ?? 'conversation') as InputMode;
  const pending = d.pending_question;

  const act = async (
    fn: () => Promise<unknown>,
    what: string,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      reload();
      return true;
    } catch (e) {
      setToast(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = (text: string, questionId?: string) =>
    act(
      () =>
        client.answerQuestion(session, {
          workspace: ws,
          answer: text,
          ...(questionId ? { question_id: questionId } : {}),
        }),
      'Answer failed',
    );

  const onAnswer = async () => {
    const text = answer.trim();
    if (!text) return;
    // Only clear the draft once the answer actually landed — a failed
    // submit must never eat the user's text.
    if (await submitAnswer(text, pending?.question_id)) setAnswer('');
  };

  const onBulk = async () => {
    const lines = splitBulkAnswers(bulk);
    if (lines.length === 0) return;
    setBusy(true);
    setBulkProgress([0, lines.length]);
    try {
      // Bulk feeds the SAME session state — sequential turns so the
      // answer-before-question ordering stays durable per line.
      for (let i = 0; i < lines.length; i++) {
        setBulkProgress([i, lines.length]);
        await client.answerQuestion(session, {
          workspace: ws,
          answer: lines[i] ?? '',
        });
      }
      setBulk('');
      reload();
    } catch (e) {
      setToast(
        `Bulk answer failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
      setBulkProgress(null);
    }
  };

  const resume = () =>
    act(async () => {
      const r = await client.resumeInterview(session, ws);
      setBriefing(r.briefing);
    }, 'Resume failed');

  return (
    <section>
      <h1 className="page-title">Discovery — {s.subject ?? s.session_id}</h1>
      <p className="page-sub">
        <Link to={projectPath(ws, '/boards')}>← boards</Link> · {s.wizard_id} v
        {s.wizard_version ?? '?'} · <StatusBadge status={s.status} />
      </p>
      {toast && <output className="warn-banner">{toast}</output>}

      {/* input modes — switchable mid-session without loss (§15.9).
          These POST a session property — toggle buttons, not tabs. */}
      <div className="row" aria-label="input mode">
        {INPUT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={mode === m.id}
            className={mode === m.id ? 'primary small' : 'small'}
            disabled={busy}
            onClick={() =>
              void act(
                () => client.setInterviewMode(session, ws, m.id),
                'Mode switch failed',
              )
            }
          >
            {m.label}
          </button>
        ))}
        <span className="spacer" />
        {s.status === 'paused' ? (
          <button
            type="button"
            className="small primary"
            disabled={busy}
            onClick={() => void resume()}
          >
            Resume…
          </button>
        ) : (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() =>
              void act(() => client.pauseInterview(session, ws), 'Pause failed')
            }
          >
            Pause
          </button>
        )}
        <button
          type="button"
          className="small danger"
          disabled={busy}
          onClick={() => setConfirmEnd(true)}
        >
          End session
        </button>
      </div>

      {/* slot progress — state chips, not a percentage (§15.9) */}
      <div className="row slot-chips" aria-label="slot progress">
        {d.slots.map((sl) => (
          <span
            key={sl.slot}
            className={`badge slot-${sl.state}`}
            title={sl.value ?? ''}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the slot tooltip/aria-label is keyboard-reachable
            tabIndex={0}
            aria-label={`${sl.slot}: ${slotStateLabel(sl)}${
              sl.value ? ` — ${sl.value}` : ''
            }`}
          >
            {sl.slot}: {slotStateLabel(sl)}
          </span>
        ))}
      </div>

      <div className="discovery-layout">
        <div className="discovery-main">
          {mode === 'bulk' ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Bulk paste</h2>
              <p className="muted">
                One answer per line — each line lands as an answer turn in this
                session (same state, same slots).
              </p>
              <textarea
                aria-label="bulk answers"
                rows={8}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder={'Paste notes, bullet lists, transcripts…'}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || splitBulkAnswers(bulk).length === 0}
                onClick={() => void onBulk()}
              >
                {bulkProgress
                  ? `Submitting ${bulkProgress[0] + 1}/${bulkProgress[1]}…`
                  : `Submit ${splitBulkAnswers(bulk).length || ''} answer${
                      splitBulkAnswers(bulk).length === 1 ? '' : 's'
                    }`}
              </button>
            </div>
          ) : (
            <div className="card" aria-label="question card">
              {pending ? (
                <>
                  <h2 style={{ marginTop: 0 }}>{pending.question}</h2>
                  <details className="provenance">
                    <summary className="muted">why this question</summary>
                    <div className="muted">{questionWhy(pending)}</div>
                  </details>
                  <textarea
                    aria-label="answer"
                    rows={4}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Your answer…"
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || !answer.trim()}
                      onClick={() => void onAnswer()}
                    >
                      Answer
                    </button>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            client.resolveQuestion(
                              session,
                              pending.question_id,
                              { workspace: ws, status: 'skipped' },
                            ),
                          'Skip failed',
                        )
                      }
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      className="small"
                      disabled={busy}
                      title="Record that you can't answer — the slot defers and is never re-asked"
                      onClick={() =>
                        void act(
                          () =>
                            client.resolveQuestion(
                              session,
                              pending.question_id,
                              { workspace: ws, status: 'unanswerable' },
                            ),
                          'Resolve failed',
                        )
                      }
                    >
                      Can't answer
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 style={{ marginTop: 0 }}>No pending question</h2>
                  <p className="muted">
                    The orchestrator only asks what materially changes the
                    outcome. Add a free-form answer below, or check the
                    Understanding Panel for open areas.
                  </p>
                  <textarea
                    aria-label="free answer"
                    rows={3}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Add context without being asked…"
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !answer.trim()}
                    onClick={() => void onAnswer()}
                  >
                    Add
                  </button>
                </>
              )}
            </div>
          )}

          {mode === 'guided' && (
            <div className="card" aria-label="guided choices">
              <h3 style={{ marginTop: 0 }}>Slot actions</h3>
              <ul className="list">
                {d.slots.map((sl) => (
                  <li key={sl.slot} className="row">
                    <span className={`badge slot-${sl.state}`}>
                      {sl.slot}: {slotStateLabel(sl)}
                    </span>
                    <span className="muted">{sl.value ?? '—'}</span>
                    <span className="spacer" />
                    {sl.state === 'inferred' && (
                      <button
                        type="button"
                        className="small"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              client.updateSlot(session, sl.slot, {
                                workspace: ws,
                                state: 'known',
                              }),
                            'Confirm failed',
                          )
                        }
                      >
                        Confirm
                      </button>
                    )}
                    <button
                      type="button"
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            client.updateSlot(session, sl.slot, {
                              workspace: ws,
                              state: 'not-applicable',
                            }),
                          'Update failed',
                        )
                      }
                    >
                      N/A
                    </button>
                    <button
                      type="button"
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            client.updateSlot(session, sl.slot, {
                              workspace: ws,
                              state: 'deferred',
                            }),
                          'Update failed',
                        )
                      }
                    >
                      Defer
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" aria-label="transcript">
            <h3 style={{ marginTop: 0 }}>Transcript</h3>
            {d.transcript.length > 30 && (
              <p className="muted" style={{ marginTop: 0 }}>
                Showing last 30 of {d.transcript.length} turns
              </p>
            )}
            <ul className="list transcript">
              {d.transcript.slice(-30).map((m) => (
                <li key={m.seq} className={`msg-${m.role}`}>
                  <span className="muted">[{m.role}]</span> {m.content}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {understandingError != null && (
          <p className="muted">
            Understanding panel unavailable.{' '}
            <button type="button" className="link" onClick={loadUnderstanding}>
              retry
            </button>
          </p>
        )}
        {understanding && (
          <UnderstandingPanel
            ws={ws}
            sessionId={session}
            understanding={understanding}
            onChanged={reload}
            onError={setToast}
          />
        )}
      </div>

      {briefing && (
        <Modal label="resume briefing" onClose={() => setBriefing(null)}>
          <strong>What changed since you left</strong>
          <ul className="list">
            {briefingLines(briefing).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            type="button"
            className="primary"
            onClick={() => setBriefing(null)}
          >
            Continue
          </button>
        </Modal>
      )}

      {confirmEnd && (
        <ConfirmDialog
          title="End session"
          body="Marks the session completed. You can still review the transcript and understanding."
          confirmLabel="End session"
          busy={busy}
          onConfirm={() => {
            setConfirmEnd(false);
            void act(
              () => client.setInterviewStatus(session, ws, 'completed'),
              'Complete failed',
            );
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
    </section>
  );
}
