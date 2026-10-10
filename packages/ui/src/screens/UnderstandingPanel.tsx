import type { KnowledgeSlotRow, StatementRow } from '@veto/core';
/**
 * Understanding Panel (PRD §15.9, wp-146 contract / wp-147 surface).
 *
 * The live sidebar during an interview: four buckets — confirmed /
 * interpretation / needs-clarification / decision-required — each item
 * carrying a provenance popover and human affordances routed through
 * the statement decide APIs. Corrections write new statement versions
 * (supersede edges), never silent overwrites. The parent screen
 * refreshes on the `interview_updated` SSE hint.
 */
import { useState } from 'react';
import { type PanelStatement, type Understanding, client } from '../api';
import { StatusBadge } from '../components';
import { DictationField } from '../dictation';
import { statementProvenance } from '../discovery';

interface PanelProps {
  ws: string;
  sessionId: string;
  understanding: Understanding;
  onChanged: () => void;
  onError: (msg: string) => void;
}

function SlotChip({ slot }: { slot: KnowledgeSlotRow }) {
  return (
    <span
      className={`badge slot-${slot.state}`}
      title={slot.value ?? ''}
      // Chips carry their value in the tooltip — tabIndex + aria-label
      // make it reachable without a pointer.
      tabIndex={0}
      aria-label={`${slot.slot}: ${slot.state}${
        slot.value ? ` — ${slot.value}` : ''
      }`}
    >
      {slot.slot}: {slot.state}
    </span>
  );
}

/** One statement row + provenance + the human decide affordances. */
export function StatementRowView({
  ws,
  sessionId,
  statement,
  slots,
  onChanged,
  onError,
}: {
  ws: string;
  sessionId: string;
  statement: PanelStatement;
  /** Slot names the corrected statement should bind back to. */
  slots?: string[] | undefined;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [correction, setCorrection] = useState(statement.text);

  const act = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <li className="statement-row">
      <StatusBadge status={statement.status} /> {statement.text}
      <details className="provenance">
        <summary className="muted">provenance</summary>
        <div className="muted">{statementProvenance(statement)}</div>
        {statement.source_text && (
          <blockquote className="muted">“{statement.source_text}”</blockquote>
        )}
      </details>
      {editing ? (
        <div className="row">
          <DictationField>
            <input
              aria-label="corrected statement"
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
            />
          </DictationField>
          <button
            type="button"
            className="small primary"
            disabled={!correction.trim()}
            onClick={() =>
              void act(async () => {
                await client.correctStatement(statement.statement_id, {
                  workspace: ws,
                  text: correction.trim(),
                  session_id: sessionId,
                  ...(slots ? { slots } : {}),
                });
                setEditing(false);
              }, 'Correct failed')
            }
          >
            Save
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </div>
      ) : disputing ? (
        <div className="row">
          <DictationField>
            <input
              aria-label="dispute reason"
              placeholder="Why is this wrong?"
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && disputeReason.trim()) {
                  const reason = disputeReason.trim();
                  setDisputing(false);
                  setDisputeReason('');
                  void act(
                    () =>
                      client.decideStatement(statement.statement_id, {
                        workspace: ws,
                        action: 'dispute',
                        reason,
                      }),
                    'Dispute failed',
                  );
                }
              }}
              // biome-ignore lint/a11y/noAutofocus: revealed by explicit click
              autoFocus
            />
          </DictationField>
          <button
            type="button"
            className="small primary"
            disabled={!disputeReason.trim()}
            onClick={() => {
              const reason = disputeReason.trim();
              setDisputing(false);
              setDisputeReason('');
              void act(
                () =>
                  client.decideStatement(statement.statement_id, {
                    workspace: ws,
                    action: 'dispute',
                    reason,
                  }),
                'Dispute failed',
              );
            }}
          >
            Dispute
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setDisputing(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="row actions">
          {statement.status !== 'confirmed' && (
            <button
              type="button"
              className="small"
              onClick={() =>
                void act(
                  () =>
                    client.decideStatement(statement.statement_id, {
                      workspace: ws,
                      action: 'confirm',
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
            onClick={() => {
              setCorrection(statement.text);
              setEditing(true);
            }}
          >
            Correct
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setDisputing(true)}
          >
            Dispute
          </button>
          <button
            type="button"
            className="small danger"
            onClick={() =>
              void act(
                () =>
                  client.decideStatement(statement.statement_id, {
                    workspace: ws,
                    action: 'reject',
                  }),
                'Reject failed',
              )
            }
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

export default function UnderstandingPanel({
  ws,
  sessionId,
  understanding: u,
  onChanged,
  onError,
}: PanelProps) {
  const [decisionText, setDecisionText] = useState<Record<string, string>>({});
  const slotsFor = (s: StatementRow): string[] | undefined => {
    const names = [
      ...u.confirmed.slots,
      ...u.interpretation.slots,
      ...u.decision_required.slots,
      ...u.needs_clarification.slots,
    ]
      .filter((sl) => (sl.statement_refs ?? []).includes(s.statement_id))
      .map((sl) => sl.slot);
    return names.length > 0 ? names : undefined;
  };

  const decide = async (
    decisionId: string,
    apply: 'confirmed' | 'rejected' | 'superseded',
  ) => {
    try {
      await client.decideStatementDecision(decisionId, {
        workspace: ws,
        decision: decisionText[decisionId] || `ruled ${apply}`,
        apply,
      });
      onChanged();
    } catch (e) {
      onError(`Decision failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const dismiss = async (decisionId: string) => {
    try {
      await client.dismissStatementDecision(decisionId, { workspace: ws });
      onChanged();
    } catch (e) {
      onError(`Dismiss failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <aside className="understanding" aria-label="understanding panel">
      <h2>Understanding</h2>
      <div className="muted understanding-readiness">
        draft{' '}
        <span
          className={u.readiness.draft_ready ? 'readiness-ok' : 'readiness-no'}
        >
          {u.readiness.draft_ready ? 'ready ✓' : 'not ready ✗'}
        </span>
        {' · '}approval{' '}
        <span
          className={
            u.readiness.approval_ready ? 'readiness-ok' : 'readiness-no'
          }
        >
          {u.readiness.approval_ready ? 'ready ✓' : 'blocked ✗'}
        </span>
      </div>
      {u.readiness.approval_blockers.length > 0 && (
        <ul className="list" aria-label="readiness blockers">
          {u.readiness.approval_blockers.map((b) => (
            <li key={b.slot} className="muted">
              {b.slot}: {b.reason}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="confirmed">
        <h3>
          Confirmed{' '}
          <span className="badge">{u.confirmed.statements.length}</span>
        </h3>
        <div className="row">
          {u.confirmed.slots.map((s) => (
            <SlotChip key={s.slot} slot={s} />
          ))}
        </div>
        <ul className="list">
          {u.confirmed.statements.map((s) => (
            <StatementRowView
              key={s.statement_id}
              ws={ws}
              sessionId={sessionId}
              statement={s}
              slots={slotsFor(s)}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      </section>

      <section aria-label="interpretation">
        <h3>
          Interpretation{' '}
          <span className="badge">{u.interpretation.statements.length}</span>
        </h3>
        <div className="row">
          {u.interpretation.slots.map((s) => (
            <SlotChip key={s.slot} slot={s} />
          ))}
        </div>
        <ul className="list">
          {u.interpretation.statements.map((s) => (
            <StatementRowView
              key={s.statement_id}
              ws={ws}
              sessionId={sessionId}
              statement={s}
              slots={slotsFor(s)}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      </section>

      <section aria-label="needs clarification">
        <h3>
          Needs clarification{' '}
          <span className="badge">
            {u.needs_clarification.slots.length +
              u.needs_clarification.clarifications.length}
          </span>
        </h3>
        <div className="row">
          {u.needs_clarification.slots.map((s) => (
            <SlotChip key={s.slot} slot={s} />
          ))}
        </div>
        <ul className="list">
          {u.needs_clarification.clarifications.map((c) => (
            <li key={c.clarification_id} className="statement-row">
              <span className="badge">clarify</span> {c.question}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="decision required">
        <h3>
          Decision required{' '}
          <span className="badge">{u.decision_required.decisions.length}</span>
        </h3>
        <div className="row">
          {u.decision_required.slots.map((s) => (
            <SlotChip key={s.slot} slot={s} />
          ))}
        </div>
        <ul className="list">
          {u.decision_required.decisions.map((d) => (
            <li key={d.decision_id} className="statement-row">
              <span className="badge attn">decision</span>{' '}
              {d.statement?.text ?? d.statement_id}
              {d.rationale && <div className="muted">{d.rationale}</div>}
              <div className="row">
                <DictationField>
                  <input
                    aria-label="ruling"
                    placeholder="ruling…"
                    value={decisionText[d.decision_id] ?? ''}
                    onChange={(e) =>
                      setDecisionText({
                        ...decisionText,
                        [d.decision_id]: e.target.value,
                      })
                    }
                  />
                </DictationField>
                {(['confirmed', 'rejected'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="small"
                    onClick={() => void decide(d.decision_id, a)}
                  >
                    {a === 'confirmed' ? 'Confirm' : 'Reject'}
                  </button>
                ))}
                <button
                  type="button"
                  className="small"
                  onClick={() => void dismiss(d.decision_id)}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
          {u.decision_required.statements
            .filter((s) => !s.open_decision)
            .map((s) => (
              <StatementRowView
                key={s.statement_id}
                ws={ws}
                sessionId={sessionId}
                statement={s}
                slots={slotsFor(s)}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
        </ul>
      </section>
    </aside>
  );
}
