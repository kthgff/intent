/**
 * Chat-to-edit composer (SCHEMAS §16, s-05-ticket-focus §Contextual AI).
 *
 * Multi-turn, ticket-scoped, `main_model` server-side. Flow: prompt →
 * interview run → proposed unified diff → human approve/discard →
 * commit + `doc_edited` event + doc_version bump. Nothing persists
 * merely because the assistant generated it. Polls `GET
 * /interview/<session>` while a run fences the session; SSE gate
 * events shortcut the poll.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type InterviewSession, client } from './api';
import { DiffView, ErrorBox } from './components';
import { useStreamRefresh } from './hooks';

export type ChatEditTarget = 'ticket' | 'prd' | 'tdd' | 'test';

const POLL_MS = 2500;

export default function ChatEdit({
  ws,
  ticketRef,
  target,
  expectedStatus,
  resume,
  onApplied,
  onClose,
}: {
  ws: string;
  /** ticket_id (subject ref) the session edits. */
  ticketRef: string;
  target: ChatEditTarget;
  /** Fence for the approve write (409 on drift). */
  expectedStatus?: string;
  /** Reattach to an existing session id (e.g. an open edit: gate). */
  resume?: string;
  onApplied?: () => void;
  onClose?: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(resume ?? null);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sessionRef = useRef<InterviewSession | null>(null);
  sessionRef.current = session;

  const refresh = useCallback(() => {
    const id = sessionId;
    if (!id) return;
    client
      .interviewSession(id, ws)
      .then(setSession)
      .catch((e) => setError(e));
  }, [sessionId, ws]);

  useEffect(() => {
    if (!sessionId) return;
    refresh();
  }, [sessionId, refresh]);

  // Poll while a run fences the session; SSE gate/run events re-read
  // in between so a finishing run flips the panel immediately.
  const status = session?.status;
  useEffect(() => {
    if (!sessionId || (status !== 'queued' && status !== 'running')) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [sessionId, status, refresh]);
  useStreamRefresh(
    useCallback(() => {
      if (sessionId) refresh();
    }, [sessionId, refresh]),
    ['gate_surfaced', 'gate_cleared', 'run_status'],
  );

  const send = async () => {
    const message = input.trim();
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.interviewEdit({
        workspace: ws,
        ticket_ref: ticketRef,
        message,
        target,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      setSessionId(r.session);
      setInput('');
      const s = await client.interviewSession(r.session, ws);
      setSession(s);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await client.interviewApprove(sessionId, expectedStatus);
      await refresh();
      onApplied?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await client.interviewDiscard(sessionId);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const turns = session?.turns ?? [];
  const open =
    status === 'queued' ||
    status === 'running' ||
    status === 'proposal' ||
    status === 'clarify' ||
    status === 'refused';

  return (
    <div className="chat-edit" data-status={status ?? 'new'}>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong>Revise with Veto</strong>
        <span className="badge">{target}.md</span>
        {status && <span className="badge">session {status}</span>}
        <span className="spacer" />
        {sessionId && open && (
          <button
            type="button"
            className="small danger"
            disabled={busy}
            onClick={() => void discard()}
          >
            Discard session
          </button>
        )}
        {onClose && (
          <button type="button" className="small" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {turns.length > 0 && (
        <div className="chat-log">
          {turns.map((t, i) => (
            <div key={`${t.ts}-${i}`} className={`chat-line chat-${t.kind}`}>
              {t.kind === 'turn' && (
                <>
                  <span className="muted">you:</span> {t.message}
                </>
              )}
              {t.kind === 'applied' && (
                <span className="muted">
                  ✓ applied{t.doc ? ` ${t.doc}` : ''}
                  {t.version != null ? ` → v${t.version}` : ''}
                </span>
              )}
              {t.kind === 'discarded' && (
                <span className="muted">✕ session discarded</span>
              )}
            </div>
          ))}
        </div>
      )}

      {(status === 'queued' || status === 'running') && (
        <p className="muted">Veto is drafting a diff…</p>
      )}
      {status === 'clarify' && (
        <p className="muted">
          Veto needs clarification — answer below to continue the session.
        </p>
      )}
      {status === 'refused' && (
        <p className="muted">
          The edit was refused (out of scope for {target}.md). Rephrase or
          discard.
        </p>
      )}

      {session?.proposal && (
        <div>
          <p className="muted">Proposed change to {session.target}:</p>
          <DiffView diff={session.proposal.diff} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void approve()}
            >
              Approve &amp; commit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void discard()}
            >
              Discard proposal
            </button>
          </div>
        </div>
      )}

      {error != null && <ErrorBox error={error} />}

      {(!status ||
        status === 'clarify' ||
        status === 'refused' ||
        status === 'proposal') && (
        <div className="row" style={{ marginTop: 8 }}>
          <input
            aria-label="edit instruction"
            placeholder={
              status === 'clarify'
                ? 'Answer Veto’s question…'
                : `Describe the change to ${target}.md…`
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void send()}
          />
          <button
            type="button"
            className="primary"
            disabled={busy || !input.trim()}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}
