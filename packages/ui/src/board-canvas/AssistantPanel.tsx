/**
 * AssistantPanel — BOARD-CHAT-PRD/TDD "UI" (wp-165). The board's shared
 * assistant thread as a floating, draggable, collapsible panel over the
 * canvas (copilot-style). Position persists to
 * `localStorage veto.boardchat.pos.<ws>/<board>`; collapsed it shrinks
 * to a corner button carrying the pending-proposal count.
 *
 * Tabs: **Thread** (transcript + pending-proposal cards with per-item
 * and accept-all controls) and **Understanding** (the wp-146 payload,
 * embedded — never duplicated). Skill pills + deterministic chips feed
 * the input; `model: 'absent'` shows the degradation banner (PRD R10).
 * Proposals always render in-thread — below 900 px or without a canvas
 * the list is the whole affordance.
 */
import type { BoardItem, BoardProposalRow } from '@veto/core';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type BoardAssistantState, type Understanding, client } from '../api';
import { Loading } from '../components';
import { DictationField } from '../dictation';
import UnderstandingPanel from '../screens/UnderstandingPanel';
import {
  groupPendingProposals,
  proposalFocusPos,
  proposalLabel,
} from './assistant';

const posKey = (ws: string, board: string) =>
  `veto.boardchat.pos.${ws}/${board}`;

function readPos(ws: string, board: string) {
  try {
    const raw = localStorage.getItem(posKey(ws, board));
    if (!raw) return null;
    const v = JSON.parse(raw) as { x?: number; y?: number };
    return Number.isFinite(v.x) && Number.isFinite(v.y)
      ? { x: v.x as number, y: v.y as number }
      : null;
  } catch {
    return null;
  }
}

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  const tag = el?.tagName.toLowerCase();
  return (
    tag === 'input' || tag === 'textarea' || el?.isContentEditable === true
  );
};

export interface AssistantPanelProps {
  ws: string;
  board: string;
  /** One-load panel state; null = still loading / fetch failed. */
  state: BoardAssistantState | null;
  /** Active board items — proposal labels + deep-link positions. */
  items: BoardItem[];
  /** The canvas selection — `/expand`'s scope source. */
  selected: string | null;
  /** Reload board + assistant state after a mutation lands. */
  onChanged: () => void;
  onError: (msg: string) => void;
  /** Pan/zoom the canvas to a position (TDD message deep-link). */
  onFocus?: (pos: { x: number; y: number }) => void;
  /** Ghost-click → open the thread at this proposal's card. `seq`
   *  retriggers the same id. */
  focusProposal?: { id: string; seq: number } | null;
}

export default function AssistantPanel({
  ws,
  board,
  state,
  items,
  selected,
  onChanged,
  onError,
  onFocus,
  focusProposal,
}: AssistantPanelProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'thread' | 'understanding'>('thread');
  const [pos, setPos] = useState(() => readPos(ws, board));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [understanding, setUnderstanding] = useState<Understanding | null>(
    null,
  );
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const pending = state?.proposals.filter((p) => p.status === 'pending') ?? [];
  const groups = groupPendingProposals(state?.proposals ?? []);

  /* Reload position when the board route changes. */
  useEffect(() => setPos(readPos(ws, board)), [ws, board]);

  /* Ghost click → open + scroll to the proposal's card. */
  useEffect(() => {
    if (!focusProposal) return;
    setOpen(true);
    setTab('thread');
    requestAnimationFrame(() => {
      // CSS.escape is defensive — proposal ids are `bp-*` by contract;
      // jsdom lacks both it and scrollIntoView.
      const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(focusProposal.id)
          : focusProposal.id;
      threadRef.current
        ?.querySelector(`#bp-${esc}`)
        ?.scrollIntoView?.({ block: 'center' });
    });
  }, [focusProposal]);

  /* Announce new turns/proposals for screen readers. */
  const lastCounts = useRef({ m: 0, p: 0 });
  useEffect(() => {
    if (!state) return;
    const m = state.messages.length;
    const p = pending.length;
    if (m > lastCounts.current.m) setAnnounce('New assistant message.');
    else if (p !== lastCounts.current.p) {
      setAnnounce(`${p} pending proposal${p === 1 ? '' : 's'}.`);
    }
    lastCounts.current = { m, p };
  }, [state, pending.length]);

  /* Auto-grow the composer with its content (the CSS max-height caps
   *  it ≈8 rows); clearing on send drops it back to the rows height.
   *  jsdom reports scrollHeight 0 — the attribute stays in charge. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!input || el.scrollHeight === 0) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  /* `/` focuses the input (inert while typing); Esc collapses. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !isEditable(e.target)) {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  /* Understanding tab loads lazily (needs the durable session). */
  const sessionId = state?.session?.session_id ?? null;
  const loadUnderstanding = useCallback(() => {
    if (!sessionId) return;
    client
      .understanding(ws, sessionId)
      .then(setUnderstanding)
      .catch(() => setUnderstanding(null));
  }, [ws, sessionId]);
  useEffect(() => {
    if (tab === 'understanding' && open) loadUnderstanding();
  }, [tab, open, loadUnderstanding]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, what: string) => {
      setBusy(true);
      try {
        await fn();
        onChanged();
      } catch (e) {
        onError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      setInput('');
      void act(() => client.assistantMessage(ws, board, t), 'Send failed');
    },
    [act, ws, board],
  );

  const runSkill = useCallback(
    (skill: string) => {
      if (skill === 'expand') {
        if (!selected) return; // pill is disabled — this is belt+braces
        void act(
          () =>
            client.assistantRun(ws, board, {
              skill: 'expand',
              scope: { item_ids: [selected] },
            }),
          'Expand failed',
        );
        return;
      }
      // interview + critique ride the message path so the invocation is
      // an attributed user turn on the shared thread.
      send(`/${skill}`);
    },
    [act, ws, board, selected, send],
  );

  const endRun = useCallback(() => {
    const branch = state?.active_run;
    if (!branch) return;
    void act(
      () => client.assistantEndRun(ws, board, branch),
      'End interview failed',
    );
  }, [act, ws, board, state?.active_run]);

  const accept = useCallback(
    (ids: string[]) =>
      void act(
        () => client.acceptProposals(ws, board, { ids }),
        'Accept failed',
      ),
    [act, ws, board],
  );
  const reject = useCallback(
    (id: string) =>
      void act(() => client.rejectProposal(ws, board, id), 'Reject failed'),
    [act, ws, board],
  );

  const focus = useCallback(
    (p: BoardProposalRow) => {
      const at = proposalFocusPos(p, items);
      if (at) onFocus?.(at);
    },
    [items, onFocus],
  );

  /* Drag by the header — pointer capture keeps the gesture off the
   * canvas; the final position persists on release. */
  const onHeaderDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (isEditable(e.target) || (e.target as HTMLElement).closest('button'))
      return;
    const el = e.currentTarget.closest('.boardchat-panel') as HTMLElement;
    const r = el.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const parent = (e.currentTarget.closest('.boardchat-panel') as HTMLElement)
      .offsetParent as HTMLElement;
    const bounds = parent?.getBoundingClientRect();
    const x = e.clientX - (bounds?.left ?? 0) - drag.current.dx;
    const y = e.clientY - (bounds?.top ?? 0) - drag.current.dy;
    setPos({
      x: Math.max(0, Math.min(x, (bounds?.width ?? 400) - 80)),
      y: Math.max(0, Math.min(y, (bounds?.height ?? 400) - 40)),
    });
  };
  const onHeaderUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      if (p) {
        try {
          localStorage.setItem(posKey(ws, board), JSON.stringify(p));
        } catch {
          /* storage is a nicety — position loss is harmless */
        }
      }
      return p;
    });
  };

  if (!open) {
    return (
      <>
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
        <button
          type="button"
          ref={toggleRef}
          className="boardchat-toggle"
          aria-label={`Board assistant${
            pending.length ? ` — ${pending.length} pending proposals` : ''
          }`}
          onClick={() => setOpen(true)}
        >
          ✦ Assistant
          {pending.length > 0 && (
            <span className="badge attn">{pending.length}</span>
          )}
        </button>
      </>
    );
  }

  return (
    <section
      className="boardchat-panel"
      aria-label="board assistant"
      style={
        pos
          ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
          : undefined
      }
    >
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
      <header
        className="boardchat-head"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <strong>Board assistant</strong>
        {state?.active_run && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={endRun}
            title={`End the ${state.active_run} interview — merges the branch and posts a readiness summary`}
          >
            End interview
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="boardchat-collapse"
          aria-label="Collapse assistant panel"
          onClick={() => {
            setOpen(false);
            toggleRef.current?.focus();
          }}
        >
          —
        </button>
      </header>

      {state?.model === 'absent' && (
        <output className="boardchat-degraded">
          No model configured — freeform commands need one. /interview, /expand
          and /critique still work.
        </output>
      )}

      <div className="mode-toggle boardchat-tabs" role="tablist">
        {(['thread', 'understanding'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'primary small' : 'small'}
            onClick={() => setTab(t)}
          >
            {t === 'thread' ? 'Thread' : 'Understanding'}
          </button>
        ))}
      </div>

      {tab === 'thread' ? (
        <>
          <div className="boardchat-thread" ref={threadRef}>
            {!state ? (
              <Loading />
            ) : state.messages.length === 0 && groups.length === 0 ? (
              <p className="muted boardchat-empty">
                Nothing yet — ask a question, or run /interview to build the
                board toward synthesis.
              </p>
            ) : (
              state.messages.map((m) => (
                <div key={m.seq} className={`boardchat-msg is-${m.role}`}>
                  <div className="boardchat-msg-meta">
                    {m.role === 'user'
                      ? (m.created_by ?? 'you')
                      : m.role === 'assistant'
                        ? 'assistant'
                        : 'thread'}
                  </div>
                  <div className="boardchat-msg-body">{m.content}</div>
                </div>
              ))
            )}

            {groups.map((g) => (
              <div className="boardchat-batch" key={g.key}>
                <div className="boardchat-batch-head">
                  <span className="badge">proposed</span>
                  {g.rows.length > 1 && (
                    <>
                      <span className="muted">{g.rows.length} changes</span>
                      <button
                        type="button"
                        className="small primary"
                        disabled={busy}
                        onClick={() => accept(g.rows.map((r) => r.proposal_id))}
                      >
                        Accept all
                      </button>
                    </>
                  )}
                </div>
                {g.rows.map((p) => (
                  <div
                    className="boardchat-proposal"
                    id={`bp-${p.proposal_id}`}
                    key={p.proposal_id}
                  >
                    <button
                      type="button"
                      className="boardchat-proposal-link"
                      onClick={() => focus(p)}
                      title="Show on canvas"
                    >
                      {proposalLabel(p, items, state?.proposals ?? [])}
                    </button>
                    <div className="boardchat-proposal-meta">
                      <span className="muted">
                        {p.op} · {p.created_by}
                      </span>
                      <button
                        type="button"
                        className="small primary"
                        disabled={busy}
                        onClick={() => accept([p.proposal_id])}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="small"
                        disabled={busy}
                        onClick={() => reject(p.proposal_id)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {state && state.chips.length > 0 && (
            <div className="boardchat-chips" aria-label="suggestions">
              {state.chips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="small"
                  disabled={busy || !c.command}
                  onClick={() => {
                    setInput(c.command);
                    inputRef.current?.focus();
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div className="boardchat-skills" aria-label="skills">
            {(state?.skills ?? []).map((s) => {
              const inert = s.skill === 'expand' && !selected;
              return (
                <button
                  key={s.skill}
                  type="button"
                  className="small"
                  disabled={busy || inert}
                  title={
                    inert
                      ? `${s.label}: select a card on the canvas first`
                      : (s.description ?? s.label)
                  }
                  onClick={() => runSkill(s.skill)}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <div className="boardchat-input">
            <DictationField onError={onError}>
              <textarea
                ref={inputRef}
                aria-label="message the board assistant"
                rows={2}
                placeholder={
                  state?.pending_question
                    ? 'Answer the question above…'
                    : 'Ask, or type / for skills'
                }
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim()) send(input);
                  }
                }}
              />
            </DictationField>
            <button
              type="button"
              className="primary small"
              disabled={busy || !input.trim()}
              onClick={() => send(input)}
            >
              Send
            </button>
          </div>
        </>
      ) : sessionId ? (
        <div className="boardchat-understanding">
          {understanding ? (
            <UnderstandingPanel
              ws={ws}
              sessionId={sessionId}
              understanding={understanding}
              onChanged={() => {
                loadUnderstanding();
                onChanged();
              }}
              onError={onError}
            />
          ) : (
            <Loading />
          )}
        </div>
      ) : (
        <p className="muted boardchat-empty">
          Understanding builds once the thread starts — send a message or run
          /interview.
        </p>
      )}
    </section>
  );
}
