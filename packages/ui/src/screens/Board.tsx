/**
 * S-01 Board — the pipeline kanban (s-01-board.md). Five phase columns
 * (Backlog·Spec·Build·Review·Done) collapse the status enum; failed/
 * blocked cards stay in the phase they died in, red-flagged. Cards
 * carry open-gate attention badges (failure/escalation loud) and
 * server-computed `drop_targets` — the board is not a status editor:
 * only human-meaningful drops (→Done = wont_do/abort, self-column
 * retry/claim) are enabled, all validated server-side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type BoardCard,
  type BoardPhase,
  type DropTarget,
  client,
} from '../api';
import {
  PHASE_LABEL,
  claimInitials,
  columnsFor,
  dropTargetFor,
  hasAttention,
  isLoudKind,
  wipExceeded,
} from '../board';
import {
  Empty,
  ErrorBox,
  KindBadge,
  Loading,
  StatusBadge,
  fmtAge,
} from '../components';
import { useStreamRefresh } from '../hooks';
import { itemTarget } from './Inbox';

const GATE_KINDS = [
  'failure',
  'escalation',
  'repair',
  'question',
  'approval',
  'review',
  'split-plan',
  'verify',
] as const;

interface PendingDrop {
  card: BoardCard;
  target: DropTarget;
}

export default function Board() {
  const [workspace, setWorkspace] = useState('');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [data, setData] = useState<Awaited<
    ReturnType<typeof client.board>
  > | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState('');
  const [onlyMoves, setOnlyMoves] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [hoverPhase, setHoverPhase] = useState<BoardPhase | null>(null);
  const [pending, setPending] = useState<PendingDrop | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    client
      .board(workspace || undefined)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [workspace]);

  useEffect(() => {
    setLoading(true);
    load();
    client
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces.map((w) => w.name)))
      .catch(() => {});
  }, [load]);

  // Live board — SSE moves cards and updates badges without reload.
  useStreamRefresh(load, [
    'gate_surfaced',
    'gate_cleared',
    'run_status',
    'ticket_updated',
  ]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const columns = useMemo(() => {
    let cards = data?.cards ?? [];
    if (kindFilter) {
      cards = cards.filter((c) =>
        c.attention.some((g) => g.kind === kindFilter),
      );
    }
    return columnsFor(cards);
  }, [data, kindFilter]);

  /** A drop → API write. `expected_status` fences stale drops; a 409
   *  surfaces a toast and the board re-syncs (never a silent move). */
  const performDrop = async (card: BoardCard, target: DropTarget) => {
    setBusy(true);
    try {
      if (target.action === 'claim') {
        await client.claim(
          card.ticket.workspace,
          card.ticket.ticket_id,
          target.gate ?? 'escalated',
        );
      } else {
        await client.action(card.ticket.workspace, card.ticket.ticket_id, {
          action: target.action,
          expected_status: card.ticket.status,
        });
      }
      setPending(null);
      load();
    } catch (e) {
      setToast(`Drop rejected: ${e instanceof Error ? e.message : String(e)}`);
      setPending(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (phase: BoardPhase) => {
    setHoverPhase(null);
    if (!dragging) return;
    const target = dropTargetFor(dragging, phase);
    if (!target) return; // invalid column — no request, card stays put
    if (target.confirm) setPending({ card: dragging, target });
    else void performDrop(dragging, target);
  };

  const snoozeAll = async (card: BoardCard) => {
    setBusy(true);
    try {
      // Board snooze = every open attention item on the ticket.
      await Promise.all(
        card.attention
          .filter((g) => !g.cleared_at)
          .map((g) =>
            client.snooze(card.ticket.workspace, g.subject, g.gate, {}),
          ),
      );
      load();
    } catch (e) {
      setToast(`Snooze failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const boardEmpty =
    data !== null && data.cards.length === 0 && data.ops.length === 0;

  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="muted" htmlFor="board-ws">
          Workspace
        </label>
        <select
          id="board-ws"
          style={{ width: 'auto' }}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="">all</option>
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <select
          aria-label="kind filter"
          style={{ width: 'auto' }}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="">all kinds</option>
          {GATE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="muted">
          <input
            type="checkbox"
            style={{ width: 'auto', marginRight: 4 }}
            checked={onlyMoves}
            onChange={(e) => setOnlyMoves(e.target.checked)}
          />
          only my moves
        </label>
        <span className="spacer" />
        <button type="button" className="small" onClick={load}>
          Refresh
        </button>
      </div>

      {error != null && <ErrorBox error={error} />}
      {toast && <output className="warn-banner">{toast}</output>}
      {loading && <Loading />}

      {data && data.ops.length > 0 && (
        <div className="ops-strip" aria-label="ops items">
          <span className="muted">⚙ Ops:</span>
          {data.ops.map((g) => (
            <Link
              key={`${g.workspace}/${g.subject}/${g.gate}`}
              className={`badge ops-chip kind-${g.kind}`}
              to={itemTarget(g)}
            >
              {g.subject} · {g.gate}
            </Link>
          ))}
        </div>
      )}

      {boardEmpty && (
        <Empty label="No tickets yet — import or create to start." />
      )}
      {boardEmpty && (
        <p className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn" to="/new">
            Create / Import →
          </Link>
        </p>
      )}

      {data && !boardEmpty && (
        <section className="board" aria-label="pipeline board">
          {columns.map((col) => {
            const overWip = wipExceeded(col.phase, col.total, data.wip_limits);
            const valid = dragging
              ? dropTargetFor(dragging, col.phase) !== undefined
              : false;
            return (
              <div
                key={col.phase}
                className={`board-col${dragging ? (valid ? ' drop-ok' : ' drop-no') : ''}${hoverPhase === col.phase && valid ? ' drop-hover' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = valid ? 'move' : 'none';
                  if (valid) setHoverPhase(col.phase);
                }}
                onDragLeave={() =>
                  setHoverPhase((h) => (h === col.phase ? null : h))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(col.phase);
                }}
              >
                <div className="board-col-head">
                  <span className="board-col-label">{col.label}</span>
                  <span
                    className={`badge${overWip ? ' wip-over' : ''}`}
                    title={overWip ? 'over WIP soft limit' : undefined}
                  >
                    {col.total}
                  </span>
                  {col.phase === 'done' && col.total > col.cards.length && (
                    <span className="muted">· recent</span>
                  )}
                </div>
                {col.cards.length === 0 && (
                  <div className="board-col-empty">—</div>
                )}
                {col.cards.map((card) => (
                  <CardView
                    key={card.ref}
                    card={card}
                    dimmed={onlyMoves && !hasAttention(card)}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => {
                      setDragging(null);
                      setHoverPhase(null);
                    }}
                    onSnooze={() => void snoozeAll(card)}
                    busy={busy}
                  />
                ))}
                {col.phase === 'done' && col.overflow.length > 0 && (
                  <button
                    type="button"
                    className="small board-more"
                    onClick={() => setShowAllDone((s) => !s)}
                  >
                    {showAllDone
                      ? 'show less'
                      : `and ${col.overflow.length} more…`}
                  </button>
                )}
                {col.phase === 'done' &&
                  showAllDone &&
                  col.overflow.map((card) => (
                    <div
                      key={card.ref}
                      className="board-card board-card-overflow"
                    >
                      <Link
                        to={`/tickets/${encodeURIComponent(card.ticket.workspace)}/${encodeURIComponent(card.ticket.ticket_id)}`}
                        className="mono"
                      >
                        {card.ticket.ticket_id}
                      </Link>{' '}
                      <span className="muted">{card.ticket.title}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        </section>
      )}

      {pending && (
        <div
          className="modal-back"
          role="presentation"
          onClick={() => setPending(null)}
          onKeyDown={(e) => e.key === 'Escape' && setPending(null)}
        >
          <dialog
            open
            className="modal"
            aria-label="confirm drop"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setPending(null);
            }}
          >
            <strong>{pending.card.ticket.ticket_id}</strong>
            <p>{pending.target.label}</p>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void performDrop(pending.card, pending.target)}
              >
                {busy ? 'Working…' : 'Confirm'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
            </div>
          </dialog>
        </div>
      )}
    </section>
  );
}

function CardView({
  card,
  dimmed,
  busy,
  onDragStart,
  onDragEnd,
  onSnooze,
}: {
  card: BoardCard;
  dimmed: boolean;
  busy: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSnooze: () => void;
}) {
  const t = card.ticket;
  const to = `/tickets/${encodeURIComponent(t.workspace)}/${encodeURIComponent(t.ticket_id)}`;
  return (
    <article
      className={`board-card${card.flagged ? ` flag-${card.flagged}` : ''}${dimmed ? ' dim' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.ref);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="board-card-head">
        <Link to={to} className="mono">
          {t.ticket_id}
        </Link>
        <StatusBadge status={t.status} />
        {card.delivery && (
          <Link
            to={`/releases/${encodeURIComponent(t.workspace)}/${encodeURIComponent(card.delivery.release_id)}`}
            className={`badge delivery-${card.delivery.state}`}
            title={`delivery: ${card.delivery.state} (${card.delivery.release_id})`}
            onClick={(e) => e.stopPropagation()}
          >
            {card.delivery.state}
          </Link>
        )}
        <span className="spacer" />
        {card.attention.some((g) => !g.cleared_at) && (
          <button
            type="button"
            className="small board-snooze"
            title="snooze — hide this card until later"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onSnooze();
            }}
          >
            z
          </button>
        )}
      </div>
      <Link to={to} className="board-card-title">
        {t.title}
      </Link>
      <div className="board-card-meta">
        {t.workspace} · {t.priority} · {fmtAge(t.created_at ?? t.updated_at)}
        {card.live_run && (
          <>
            {' '}
            ·{' '}
            <Link to={`/runs/${encodeURIComponent(card.live_run.id)}`}>
              ▶ {card.live_run.stage}
            </Link>
          </>
        )}
      </div>
      {card.attention.length > 0 && (
        <div className="board-card-badges">
          {card.attention
            .filter((g) => !g.cleared_at)
            .map((g) => (
              <span
                key={g.gate}
                className={`attn${isLoudKind(g.kind) ? ' loud' : ''}`}
                title={
                  g.snoozed_until
                    ? `${g.gate} (snoozed until ${g.snoozed_until})`
                    : g.gate
                }
              >
                <KindBadge kind={g.kind} />
                {g.claim && <i>{claimInitials(g.claim.claimed_by)}</i>}
              </span>
            ))}
        </div>
      )}
    </article>
  );
}
