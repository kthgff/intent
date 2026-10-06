/**
 * wp-111 — rs-quality findings panel (S-05 gate + S-06 doc review).
 *
 * The PRD's cited AI quality pass (rs-quality.json, SCHEMAS §24). The
 * artifact carries no score and no approval — this panel renders the
 * findings and their citations; it never approves anything itself.
 */
import type { RsQualityFinding } from '@veto/core';
import { Citation, isCodeRef } from './Evidence';
import { ApiError, client } from './api';
import { Empty, ErrorBox, Loading } from './components';
import { useLoad } from './hooks';

const SEV_CLASS: Record<string, string> = {
  critical: 'spec-bad',
  moderate: 'spec-warn',
  minor: 'spec-good',
};

export function QualityFindingCard({
  ws,
  f,
}: {
  ws: string;
  f: RsQualityFinding;
}) {
  return (
    <div className="card">
      <div className="card-title">
        <span className={`badge ${SEV_CLASS[f.severity] ?? ''}`}>
          {f.severity}
        </span>
        <span className="badge">{f.dimension}</span>
        <span className="mono muted">{f.id}</span>
        <span className="badge">{f.status}</span>
      </div>
      <p>{f.claim}</p>
      {f.ref && <div className="card-meta mono">ref: {f.ref}</div>}
      {f.suggested_fix && (
        <div className="card-meta">suggested fix: {f.suggested_fix}</div>
      )}
      {f.confidence != null && (
        <div className="card-meta">confidence: {f.confidence.toFixed(2)}</div>
      )}
      <div className="card-meta">
        citations:{' '}
        {f.citations.map((c) =>
          isCodeRef(c) ? (
            <Citation key={c} ws={ws} ref={c} />
          ) : (
            <span key={c} className="mono muted" style={{ marginRight: 8 }}>
              {c}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Latest rs-quality pass for the ticket. `severity` filters the list
 * (the rs-quality gate shows criticals only; the doc-review rail
 * shows everything). A 404 is an honest "no pass recorded" — render
 * null, not an error.
 */
export default function RsQualityPanel({
  ws,
  id,
  severity,
}: {
  ws: string;
  id: string;
  severity?: 'critical' | 'moderate' | 'minor';
}) {
  const q = useLoad(() => client.rsQuality(ws, id), [ws, id]);
  if (q.loading) return <Loading />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) return null;
    return <ErrorBox error={q.error} />;
  }
  const quality = q.data?.quality;
  if (!quality) return null;
  const findings = (quality.findings ?? []).filter(
    (f) => severity === undefined || f.severity === severity,
  );
  return (
    <div>
      <div className="card-meta" style={{ marginBottom: 6 }}>
        AI quality pass · {quality.dimensions_checked.length} dimensions checked
        {quality.doc_version != null && ` · rs.md v${quality.doc_version}`}
        {` · run ${q.data?.run_id}`} — advisory findings, not a score
      </div>
      {findings.length === 0 && (
        <Empty
          label={
            severity === 'critical'
              ? 'No critical findings.'
              : 'Clean pass — no findings.'
          }
        />
      )}
      {findings.map((f) => (
        <QualityFindingCard key={f.id} ws={ws} f={f} />
      ))}
    </div>
  );
}
