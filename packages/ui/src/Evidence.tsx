/**
 * wp-111 — navigable `code:` citations (INTELLIGENCE §4.1).
 *
 * Every stage output cites code as `code:<repo>:<sha>:<path>:<tail>`
 * (SCHEMAS §17 object_ref). Citation resolves the ref through
 * GET /evidence/source into a SourceCard: the pinned commit, the
 * indexed unit's content, and a freshness badge — a stale pin renders
 * as stale, never as current evidence.
 */
import { useState } from 'react';
import { type EvidenceSource, client } from './api';
import { ErrorBox } from './components';

export function isCodeRef(ref: string | null | undefined): ref is string {
  return typeof ref === 'string' && ref.startsWith('code:');
}

/** `code:repo:sha:path:tail` → `path:tail` (the human-readable part). */
export function shortRef(ref: string): string {
  const m = /^code:[^:]+:[0-9a-f]{7,40}:(.+)$/.exec(ref);
  return m?.[1] ?? ref;
}

/** Pinned source — commit, unit, content, freshness. */
export function SourceCard({ src }: { src: EvidenceSource }) {
  return (
    <div className="card">
      <div className="card-title">
        <span className="mono">
          {src.repo}@{src.commit_sha.slice(0, 12)}
        </span>
        <span className="mono muted">{src.path}</span>
        {src.unit?.symbol && <span className="muted">{src.unit.symbol}</span>}
        {src.unit && (
          <span className="muted mono">
            L{src.unit.start_line}–L{src.unit.end_line}
          </span>
        )}
        <span
          className={`badge ${src.freshness === 'current' ? 'spec-good' : 'spec-warn'}`}
        >
          {src.freshness}
        </span>
      </div>
      {src.freshness === 'stale' && (
        <div className="card-meta">
          index head moved
          {src.current_head ? ` to ${src.current_head.slice(0, 12)}` : ''} —
          this citation pins an older commit
        </div>
      )}
      {src.unit === null && (
        <div className="card-meta">unit not indexed at this pin</div>
      )}
      {src.unit !== null && <pre>{src.unit.content}</pre>}
    </div>
  );
}

/**
 * A `code:` citation rendered as an expandable ref; clicking loads the
 * pinned source inline. Non-code refs render as plain text.
 */
export function Citation({
  ws,
  ref: refStr,
  label,
}: {
  ws: string;
  ref: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<EvidenceSource | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!isCodeRef(refStr)) {
    return <span className="mono muted">{refStr}</span>;
  }
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (src || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setSrc(await client.evidenceSource(ws, refStr));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="citation">
      <button
        type="button"
        className="small mono"
        title={refStr}
        onClick={() => void toggle()}
      >
        {label ?? shortRef(refStr)}
      </button>
      {open && busy && <span className="muted">…</span>}
      {open && err != null && <ErrorBox error={err} />}
      {open && src && <SourceCard src={src} />}
    </span>
  );
}
