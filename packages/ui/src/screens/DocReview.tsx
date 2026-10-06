/**
 * S-06 — doc review page: rendered markdown, version diffs, feedback
 * (→ revision run) and approve (clears the review gate).
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import RsQualityPanel from '../RsQuality';
import { client } from '../api';
import { DiffView, Empty, ErrorBox, Loading, Markdown } from '../components';
import { useLoad } from '../hooks';

export default function DocReview() {
  const { ws = '', id = '', name = 'prd' } = useParams();
  const navigate = useNavigate();
  const doc = useLoad(() => client.ticketDoc(ws, id, name), [ws, id, name]);
  const [showDiff, setShowDiff] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const back = `/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;

  const send = async (kind: 'feedback' | 'approve') => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await client.docApprove(ws, id, name);
        setDone('Approved — review gate cleared.');
      } else {
        const r = await client.docFeedback(ws, id, name, feedback);
        setDone(`Feedback committed — revision run ${r.run} queued.`);
      }
      setTimeout(() => navigate(back), 1200);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 className="page-title">
        {name}.md — {id}
      </h1>
      <p className="page-sub">
        <Link to={back}>← ticket</Link> · doc review
      </p>
      {doc.loading && <Loading />}
      {doc.error != null && <ErrorBox error={doc.error} />}
      {error != null && <ErrorBox error={error} />}
      {done && <div className="card">{done}</div>}
      {doc.data && (
        <div className="split">
          <div className="grow">
            <Markdown text={doc.data.content} />
          </div>
          <aside className="rail">
            {doc.data.doc === 'rs.md' && <RsQualityPanel ws={ws} id={id} />}
            <div className="card">
              <strong>Versions ({doc.data.diffs.length + 1})</strong>
              {doc.data.diffs.length === 0 && (
                <div className="card-meta">first version</div>
              )}
              {doc.data.diffs.map((dd, i) => (
                <div key={dd.to} className="card-meta">
                  <button
                    type="button"
                    className="small"
                    onClick={() => setShowDiff(showDiff === i ? null : i)}
                  >
                    {dd.from} → {dd.to}
                  </button>
                </div>
              ))}
            </div>
            <div className="card">
              <strong>Feedback</strong>
              <textarea
                aria-label="feedback"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should the agent change?"
              />
              <div className="row">
                <button
                  type="button"
                  disabled={busy || !feedback.trim()}
                  onClick={() => void send('feedback')}
                >
                  Send feedback
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void send('approve')}
                >
                  Approve
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
      {doc.data && showDiff !== null && doc.data.diffs[showDiff] && (
        <DiffView diff={doc.data.diffs[showDiff]?.diff ?? ''} />
      )}
      {doc.data === null && !doc.loading && !doc.error && (
        <Empty label="Doc not found." />
      )}
    </section>
  );
}
