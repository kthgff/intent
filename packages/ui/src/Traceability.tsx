/**
 * wp-111 — traceability panel (S-05 ticket focus, INTELLIGENCE §12).
 *
 * Goal/AC/ticket/PR/commit/code/test edges for a subject with the
 * honesty cues the spec demands: provenance (`source`), `confidence`
 * on inferred links, the `valid_at` version boundary, and a
 * verification badge where `auto-verified` renders as automated —
 * never the same as human `verified`.
 *
 * Verify/reject goes through POST /links/decide with `expected` = the
 * state the human saw (OCC): a racing write surfaces a visible 409 and
 * the panel reloads. Decisions are idempotent + evented server-side.
 */
import type { Relation, RelationVerification } from '@sprint-runner/core';
import { useState } from 'react';
import { Citation, isCodeRef } from './Evidence';
import { client } from './api';
import { Empty, ErrorBox, Loading } from './components';
import { useLoad } from './hooks';

const VERIF_LABEL: Record<string, string> = {
  suggested: 'suggested',
  'auto-verified': 'auto-verified',
  verified: 'verified',
  rejected: 'rejected',
};

const VERIF_CLASS: Record<string, string> = {
  suggested: 'spec-warn',
  'auto-verified': 'spec-warn',
  verified: 'spec-good',
  rejected: 'spec-bad',
};

const edgeKey = (e: Relation) => `${e.subject}${e.predicate}${e.object}`;

function VerificationBadge({ edge }: { edge: Relation }) {
  const v = edge.verification ?? 'unset';
  return (
    <span className={`badge ${VERIF_CLASS[v] ?? ''}`}>
      {VERIF_LABEL[v] ?? v}
    </span>
  );
}

export default function Traceability({
  ws,
  subject,
}: {
  ws: string;
  subject: string;
}) {
  const links = useLoad(() => client.links(ws, subject), [ws, subject]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (edge: Relation, action: 'verify' | 'reject') => {
    setBusy(edgeKey(edge));
    setErr(null);
    try {
      await client.decideLink({
        workspace: ws,
        subject: edge.subject,
        predicate: edge.predicate,
        object: edge.object,
        action,
        expected:
          (edge.verification as RelationVerification | undefined) ?? null,
      });
      await links.reload();
    } catch (e) {
      // Conflict/stale/unauthorized — reload so the panel shows the
      // state the race actually landed, then surface the error.
      await links.reload();
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (links.loading) return <Loading />;
  if (links.error) return <ErrorBox error={links.error} />;
  const edges = links.data?.relations ?? [];
  if (edges.length === 0) {
    return <Empty label="No traceability links recorded for this subject." />;
  }
  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      {edges.map((e) => {
        const canVerify =
          e.verification !== 'verified' && e.verification !== 'auto-verified';
        const canConfirm = e.verification === 'auto-verified';
        const canReject = e.verification !== 'rejected';
        const key = edgeKey(e);
        return (
          <div className="card" key={key}>
            <div className="card-title">
              <VerificationBadge edge={e} />
              <span className="mono muted">
                {e.subject} -[{e.predicate}]-&gt;
              </span>
              {isCodeRef(e.object) ? (
                <Citation ws={ws} ref={e.object} />
              ) : (
                <span className="mono">{e.object}</span>
              )}
              <span className="spacer" />
              {(canVerify || canConfirm) && (
                <button
                  type="button"
                  className="small primary"
                  disabled={busy === key}
                  onClick={() => void decide(e, 'verify')}
                >
                  {canConfirm ? 'confirm (human)' : 'verify'}
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  className="small danger"
                  disabled={busy === key}
                  onClick={() => void decide(e, 'reject')}
                >
                  reject
                </button>
              )}
            </div>
            <div className="card-meta">
              source: {e.source ?? 'explicit'}
              {e.confidence !== undefined &&
                ` · confidence ${e.confidence.toFixed(2)}`}
              {e.valid_at && ` · valid at ${e.valid_at.slice(0, 12)}`}
              {e.verification === 'auto-verified' &&
                ' · automated — human confirm required before it counts as verified'}
            </div>
            {e.evidence && isCodeRef(e.evidence) && (
              <div className="card-meta">
                evidence: <Citation ws={ws} ref={e.evidence} />
              </div>
            )}
            {e.evidence && !isCodeRef(e.evidence) && (
              <div className="card-meta">evidence: {e.evidence}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
