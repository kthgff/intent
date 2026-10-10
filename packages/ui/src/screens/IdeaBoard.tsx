/**
 * S-16 — Board canvas route (s-16-board-canvas.md, BOARD-CANVAS-TDD,
 * PRD §15.3).
 *
 * Idea mode renders the spatial canvas (React Flow 12) behind the
 * `ui.idea_canvas_v2` rollout flag; flag-off keeps the grouped classic
 * view. The route is a coordinator — durable state loads here,
 * mutations merge server rows back into the projection, and the canvas
 * never holds a second source of truth.
 *
 * Delivery mode embeds the S-01 pipeline kanban scoped to this
 * workspace (the shared component per D21).
 */
import type { BoardConnector, BoardItem, BoardVote } from '@veto/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  type BoardAssistantState,
  type IdeaBoardDetail,
  client,
} from '../api';
import { columnsFor } from '../board';
import AssistantPanel from '../board-canvas/AssistantPanel';
import BoardCanvas, {
  type BoardCanvasHandlers,
} from '../board-canvas/BoardCanvas';
import EasyEdit from '../board-canvas/EasyEdit';
import { BoardInspector } from '../board-canvas/Inspector';
import type { ItemMutation } from '../board-canvas/history';
import { Empty, ErrorBox, Loading, StatusBadge } from '../components';
import { groupCanvasItems, isConsumedItem, noteKindMeta } from '../discovery';
import { useBoardItemRefresh, useStreamRefresh } from '../hooks';
import { projectPath } from '../project';

/** Narrow-screen read mode — below 900 px the canvas is pan/zoom/read
 *  with an Open-inspector action; creation stays on Quick Capture
 *  (⌘⇧C) or the Easy Edit capture form. */
function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia('(max-width: 899px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const h = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return narrow;
}

export default function IdeaBoard() {
  const { ws = '', board = '' } = useParams();
  const [data, setData] = useState<IdeaBoardDetail | null>(null);
  const [tray, setTray] = useState<BoardItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<'idea' | 'edit' | 'delivery'>(() => {
    const v = searchParams.get('view');
    return v === 'edit' || v === 'delivery' ? v : 'idea';
  });
  const switchMode = useCallback(
    (m: 'idea' | 'edit' | 'delivery') => {
      setMode(m);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('view', m);
          if (m !== 'edit') next.delete('item');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const [delivery, setDelivery] = useState<Awaited<
    ReturnType<typeof client.board>
  > | null>(null);
  const [deliveryError, setDeliveryError] = useState<unknown>(null);
  const [taxonomy, setTaxonomy] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [canvasV2, setCanvasV2] = useState<boolean | null>(null);
  const [canvasDraw, setCanvasDraw] = useState(false);
  const [boardChat, setBoardChat] = useState(false);
  const [assistant, setAssistant] = useState<BoardAssistantState | null>(null);
  /** BOARD-CHAT deep-links: `focusReq` pans the canvas to a position;
   *  `panelFocus` scrolls the thread to a proposal card. `seq` makes
   *  a repeated request re-fire. */
  const [focusReq, setFocusReq] = useState<{
    x: number;
    y: number;
    seq: number;
  } | null>(null);
  const [panelFocus, setPanelFocus] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const focusSeq = useRef(0);
  const narrow = useNarrowScreen();
  /** `?votes=show` — closed-session tallies surface on demand. */
  const showVotes = searchParams.get('votes') === 'show';
  const editorId = searchParams.get('item');
  // Easy Edit is a canvas-era view — flag-off boards coerce it back to
  // the classic idea view.
  const effMode = mode === 'edit' && canvasV2 !== true ? 'idea' : mode;

  const load = useCallback(() => {
    if (!ws || !board) return;
    client
      .ideaBoard(ws, board)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    client
      .tray(ws)
      .then((r) => setTray(r.items))
      .catch(() => {});
  }, [ws, board]);

  useEffect(() => {
    load();
    client
      .boardTaxonomy()
      .then((t) => setTaxonomy(t.note_kinds))
      .catch(() => {});
    client
      .settings()
      .then((r) => {
        const ui = (r.config?.ui ?? {}) as {
          idea_canvas_v2?: unknown;
          canvas_draw?: unknown;
          board_chat?: unknown;
        };
        setCanvasV2(ui.idea_canvas_v2 === true);
        setCanvasDraw(ui.canvas_draw === true);
        setBoardChat(ui.board_chat === true);
      })
      .catch(() => setCanvasV2(false));
  }, [load]);

  useEffect(() => {
    if (effMode !== 'delivery' || !ws) return;
    client
      .board(ws)
      .then((d) => {
        setDelivery(d);
        setDeliveryError(null);
      })
      .catch(setDeliveryError);
  }, [effMode, ws]);

  /** Board Assistant panel state — flag-gated, loaded once the flag is
   *  known; every SSE/board refresh re-reads it with the canvas. */
  const loadAssistant = useCallback(() => {
    if (!boardChat || !ws || !board) return;
    client
      .assistant(ws, board)
      .then(setAssistant)
      .catch(() => {});
  }, [boardChat, ws, board]);

  useEffect(() => {
    loadAssistant();
  }, [loadAssistant]);

  const refreshAll = useCallback(() => {
    load();
    loadAssistant();
  }, [load, loadAssistant]);

  useStreamRefresh(refreshAll, [
    'interview_updated',
    'ticket_updated',
    'board_proposal',
  ]);
  useBoardItemRefresh(refreshAll);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Merge server rows back into the projection — the canvas never
   *  keeps its own copy of durable state. */
  const mergeItems = useCallback((rows: BoardItem[]) => {
    setData((d) => {
      if (!d) return d;
      return {
        ...d,
        items: d.items.map((s) => {
          const u = rows.find((r) => r.id === s.item.id);
          return u ? { ...s, item: u } : s;
        }),
      };
    });
  }, []);

  const mergeConnector = useCallback((c: BoardConnector) => {
    setData((d) => {
      if (!d) return d;
      const rest = (d.connectors ?? []).filter((x) => x.id !== c.id);
      return { ...d, connectors: [...rest, c] };
    });
  }, []);

  const patchItem = async (item: BoardItem, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const { item: updated } = await client.patchBoardItem(item.id, {
        workspace: ws,
        ...(item.updated_at != null
          ? { expected_updated_at: item.updated_at }
          : {}),
        ...patch,
      });
      mergeItems([updated]);
      if (patch.board === null) load(); // → tray
      return { ok: true, conflict: false };
    } catch (e) {
      setToast(
        `Couldn't save changes: ${e instanceof Error ? e.message : String(e)}`,
      );
      load();
      return { ok: false, conflict: e instanceof ApiError && e.status === 409 };
    } finally {
      setBusy(false);
    }
  };

  const handlers: BoardCanvasHandlers = useMemo(
    () => ({
      add: async (input) => {
        const { item } = await client.addBoardItem(board, {
          workspace: ws,
          ...input,
          ...(input.kind === 'note' ? { note_kind: 'idea' } : {}),
        });
        setData((d) =>
          d ? { ...d, items: [...d.items, { item, statements: [] }] } : d,
        );
        return item;
      },
      mutate: async (mutations: ItemMutation[]) => {
        const { items } = await client.patchBoardItems(board, {
          workspace: ws,
          mutations,
        });
        mergeItems(items);
        return items;
      },
      connect: async (source, target) => {
        const { connector } = await client.addBoardConnector(board, {
          workspace: ws,
          source_item_id: source,
          target_item_id: target,
        });
        mergeConnector(connector);
        return connector;
      },
      patchConnector: async (id, patch, expected) => {
        const { connector } = await client.patchBoardConnector(board, id, {
          workspace: ws,
          ...patch,
          expected_updated_at: expected,
        });
        if (connector) mergeConnector(connector);
        return connector;
      },
      removeConnector: async (id) => {
        await client.removeBoardConnector(board, id, ws);
        setData((d) =>
          d
            ? {
                ...d,
                connectors: (d.connectors ?? []).map((c) =>
                  c.id === id ? { ...c, status: 'superseded' as const } : c,
                ),
              }
            : d,
        );
      },
      promote: async (item, pos) => {
        await client.patchBoardItem(item.id, {
          workspace: ws,
          ...(item.updated_at != null
            ? { expected_updated_at: item.updated_at }
            : {}),
          board,
          status: 'active',
          ...(pos ? { x: pos.x, y: pos.y } : {}),
        });
        load();
      },
      addAnnotation: async (input) => {
        const { annotation } = await client.addBoardAnnotation(board, {
          workspace: ws,
          kind: input.kind,
          geometry: input.geometry,
        });
        setData((d) =>
          d ? { ...d, annotations: [...(d.annotations ?? []), annotation] } : d,
        );
        return annotation;
      },
      removeAnnotation: async (id) => {
        await client.deleteBoardAnnotation(board, id, ws);
        setData((d) =>
          d
            ? {
                ...d,
                annotations: (d.annotations ?? []).filter((a) => a.id !== id),
              }
            : d,
        );
      },
      castVote: async (input) => {
        const { vote } = await client.castBoardVote(board, {
          workspace: ws,
          session_id: input.session_id,
          item_id: input.item_id,
          stamp: input.stamp,
        });
        // Re-vote is an upsert — replace the caller's row for this
        // item/session rather than appending a duplicate.
        setData((d) =>
          d
            ? {
                ...d,
                votes: [
                  ...(d.votes ?? []).filter(
                    (v: BoardVote) =>
                      !(
                        v.item_id === vote.item_id &&
                        v.session_id === vote.session_id &&
                        v.voter === vote.voter
                      ),
                  ),
                  vote,
                ],
              }
            : d,
        );
        return vote;
      },
      openVoteSession: async () => {
        const { session } = await client.openVoteSession(board, {
          workspace: ws,
        });
        setData((d) =>
          d
            ? {
                ...d,
                vote_sessions: [...(d.vote_sessions ?? []), session],
              }
            : d,
        );
        return session;
      },
      closeVoteSession: async (session) => {
        const { session: closed } = await client.closeVoteSession(
          board,
          session.id,
          {
            workspace: ws,
            expected_updated_at: session.updated_at ?? '',
          },
        );
        setData((d) =>
          d
            ? {
                ...d,
                vote_sessions: (d.vote_sessions ?? []).map((s) =>
                  s.id === closed.id ? closed : s,
                ),
              }
            : d,
        );
        return closed;
      },
      refresh: load,
      notice: (m) => setToast(m),
    }),
    [ws, board, load, mergeItems, mergeConnector],
  );

  /** Easy Edit create — positionless by design; the canvas's transient
   *  layout places the item on next view. */
  const easyAdd = useCallback(
    async (input: { kind?: string; note_kind?: string }) => {
      const { item } = await client.addBoardItem(board, {
        workspace: ws,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.note_kind !== undefined
          ? { note_kind: input.note_kind }
          : input.kind === 'note' || input.kind === undefined
            ? { note_kind: 'idea' }
            : {}),
      });
      setData((d) =>
        d ? { ...d, items: [...d.items, { item, statements: [] }] } : d,
      );
      return item;
    },
    [ws, board],
  );

  /** Easy Edit "Note to tray" — capture ingress, then refresh tray. */
  const easyCapture = useCallback(
    async (title: string) => {
      await client.capture({ workspace: ws, title });
      load();
    },
    [ws, load],
  );

  const closeInspector = useCallback(() => {
    const id = selected;
    setSelected(null);
    if (!id) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
        ?.focus();
    });
  }, [selected]);

  if (loading && !data)
    return (
      <section className="canvas-route-state">
        <Loading />
      </section>
    );
  if (error != null && !data)
    return (
      <section className="canvas-route-state">
        <ErrorBox error={error} />
      </section>
    );
  if (!data)
    return (
      <section className="canvas-route-state">
        <Empty />
      </section>
    );
  if (canvasV2 === null)
    return (
      <section className="canvas-route-state">
        <Loading />
      </section>
    );

  const selectedSurface = data.items.find((s) => s.item.id === selected);

  return (
    <section
      className={`idea-board-screen${
        canvasV2 && effMode !== 'delivery' ? ' board-route' : ''
      }`}
    >
      {canvasV2 && effMode !== 'delivery' ? (
        <>
          <header
            className={`canvas-topbar${effMode === 'edit' ? ' easy-edit-topbar' : ''}`}
          >
            <Link
              to={projectPath(ws, '/boards')}
              className="small"
              aria-label="Back to boards"
            >
              ← Boards
            </Link>
            <strong className="canvas-board-name">
              {data.board.name ?? board}
            </strong>
            <span className="muted canvas-workspace">{ws}</span>
            {data.board.status && <StatusBadge status={data.board.status} />}
            <span className="spacer" />
            <div className="mode-toggle" role="tablist" aria-label="board mode">
              {(['idea', 'edit', 'delivery'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={effMode === m}
                  className={effMode === m ? 'primary small' : 'small'}
                  onClick={() => switchMode(m)}
                >
                  {m === 'idea'
                    ? 'Idea'
                    : m === 'edit'
                      ? 'Easy Edit'
                      : 'Delivery'}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="primary small canvas-synthesize"
              disabled
              title="Synthesize isn't available yet"
            >
              Synthesize
            </button>
          </header>

          {toast && <output className="warn-banner">{toast}</output>}
          {error != null && <ErrorBox error={error} />}

          {effMode === 'idea' ? (
            <>
              <BoardCanvas
                data={data}
                ws={ws}
                board={board}
                tray={tray}
                readOnly={narrow}
                taxonomy={taxonomy}
                drawEnabled={canvasDraw}
                showVotes={showVotes}
                selected={selected}
                onSelect={setSelected}
                handlers={handlers}
                // BOARD-CHAT (wp-165/166): pending proposals project as
                // ghosts; below 900 px they stay list-only in the
                // thread (TDD responsive rule).
                proposals={narrow ? [] : (assistant?.proposals ?? [])}
                onGhostClick={(p) =>
                  setPanelFocus({ id: p.proposal_id, seq: ++focusSeq.current })
                }
                focus={focusReq}
              />

              {selectedSurface && (
                <BoardInspector
                  surface={selectedSurface}
                  busy={busy}
                  ws={ws}
                  taxonomy={taxonomy}
                  onPatch={(patch) =>
                    void patchItem(selectedSurface.item, patch)
                  }
                  onClose={closeInspector}
                  onChanged={load}
                  onError={(m) => setToast(m)}
                  readOnly={narrow}
                />
              )}

              {boardChat && (
                <AssistantPanel
                  ws={ws}
                  board={board}
                  state={assistant}
                  items={data.items.map((s) => s.item)}
                  selected={selected}
                  focusProposal={panelFocus}
                  onChanged={refreshAll}
                  onError={(m) => setToast(m)}
                  onFocus={(pos) =>
                    setFocusReq({ ...pos, seq: ++focusSeq.current })
                  }
                />
              )}
            </>
          ) : (
            <EasyEdit
              surfaces={data.items}
              tray={tray}
              ws={ws}
              board={board}
              taxonomy={taxonomy}
              patchItem={patchItem}
              mutate={handlers.mutate}
              promote={handlers.promote}
              add={easyAdd}
              capture={easyCapture}
              refresh={load}
              notice={(m) => setToast(m)}
              busy={busy}
              editorId={editorId}
              boardName={data.board.name ?? board}
              openEditor={(id) =>
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set('view', 'edit');
                  next.set('item', id);
                  return next;
                })
              }
              closeEditor={() =>
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.delete('item');
                    next.set('view', 'edit');
                    return next;
                  },
                  { replace: true },
                )
              }
            />
          )}
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              ◆ {data.board.name ?? board}
            </h1>
            <span className="muted">{ws}</span>
            {data.board.board_type && (
              <span className="badge">{data.board.board_type}</span>
            )}
            {data.board.status && <StatusBadge status={data.board.status} />}
            <span className="spacer" />
            <div className="mode-toggle" role="tablist" aria-label="board mode">
              {(['idea', 'delivery'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? 'primary small' : 'small'}
                  onClick={() => switchMode(m)}
                >
                  {m === 'idea' ? 'Idea' : 'Delivery'}
                </button>
              ))}
            </div>
            <button type="button" className="small" onClick={load}>
              Refresh
            </button>
          </div>

          {toast && <output className="warn-banner">{toast}</output>}
          {error != null && <ErrorBox error={error} />}

          {effMode === 'idea' ? (
            canvasV2 === false ? (
              <ClassicBoard
                items={data.items.map((s) => s.item)}
                selected={selected}
                onSelect={setSelected}
              />
            ) : (
              <Loading />
            )
          ) : deliveryError != null ? (
            <ErrorBox error={deliveryError} />
          ) : (
            <DeliveryView data={delivery} />
          )}

          {effMode === 'idea' && canvasV2 === false && selectedSurface && (
            <BoardInspector
              surface={selectedSurface}
              busy={busy}
              ws={ws}
              taxonomy={taxonomy}
              onPatch={(patch) => void patchItem(selectedSurface.item, patch)}
              onClose={closeInspector}
              onChanged={load}
              onError={(m) => setToast(m)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Classic grouped view — the flag-off fallback while the v2 canvas
 *  rolls out (read surface + inspector; no canvas chrome). */
function ClassicBoard({
  items,
  selected,
  onSelect,
}: {
  items: BoardItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const lanes = groupCanvasItems(items, 'zone');
  return (
    <div className="canvas canvas-zone" aria-label="idea canvas">
      {lanes.map((lane) => (
        <div key={lane.key} className="canvas-lane">
          <div className="canvas-lane-head">
            {lane.label}
            <span className="badge">{lane.items.length}</span>
          </div>
          {lane.items.map((item) => {
            const meta = noteKindMeta(item.note_kind);
            return (
              <button
                type="button"
                key={item.id}
                className={`sticky note-${meta.color}${
                  isConsumedItem(item) ? ' dim' : ''
                }${selected === item.id ? ' selected' : ''}`}
                onClick={() => onSelect(selected === item.id ? null : item.id)}
              >
                <span className="sticky-chip">
                  {meta.icon} {meta.label}
                </span>
                <span className="sticky-text">
                  {item.title ?? item.body ?? '(untitled)'}
                </span>
                {isConsumedItem(item) && item.consumed_by && (
                  <span className="muted">→{item.consumed_by}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Delivery mode — the S-01 pipeline kanban scoped to this workspace
 *  (D21: two boards, one component). Read-only mirror here; the full
 *  action surface lives on Home. */
function DeliveryView({
  data,
}: {
  data: Awaited<ReturnType<typeof client.board>> | null;
}) {
  if (!data) return <Loading />;
  const columns = columnsFor(data.cards);
  return (
    <section className="board" aria-label="delivery board">
      {columns.map((col) => (
        <div key={col.phase} className="board-col">
          <div className="board-col-head">
            <span className="board-col-label">{col.label}</span>
            <span className="badge">{col.total}</span>
          </div>
          {col.cards.map((card) => (
            <article key={card.ref} className="board-card">
              <div className="board-card-head">
                <Link
                  to={projectPath(
                    card.ticket.workspace,
                    `/tickets/${encodeURIComponent(card.ticket.ticket_id)}`,
                  )}
                  className="mono"
                >
                  {card.ticket.ticket_id}
                </Link>
                <StatusBadge status={card.ticket.status} />
              </div>
              <span className="board-card-title">{card.ticket.title}</span>
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}
