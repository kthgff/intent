import type { TriageQuestion } from '@sprint-runner/core';
/**
 * S-04 — Q&A wizard. One question per card; options with `recommended`
 * badges; "Other…"; skip = accept; Accept-all; progress; bail-outs
 * (force-ready, wont-do). Serves triage needs-info, design-qa, and
 * interview follow-ups (shared component per UI-INVENTORY §3).
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { client } from '../api';
import { Empty, ErrorBox, Loading } from '../components';
import { useLoad } from '../hooks';
import {
  type WizardState,
  acceptAll,
  answer,
  answersPayload,
  currentQuestion,
  defaultAnswer,
  initWizard,
  progress,
  skip,
} from '../wizard';

function OptionList({
  q,
  state,
  onAnswer,
}: {
  q: TriageQuestion;
  state: WizardState;
  onAnswer: (v: string) => void;
}) {
  const [other, setOther] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  if (q.format === 'text') {
    return (
      <div>
        <textarea
          aria-label="answer"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder={q.default ?? 'Type your answer…'}
        />
        <button
          type="button"
          className="primary"
          disabled={!other.trim()}
          onClick={() => onAnswer(other.trim())}
        >
          Answer
        </button>
      </div>
    );
  }
  if (q.format === 'yesno') {
    return (
      <div className="option-list">
        {['yes', 'no'].map((v) => (
          <button key={v} type="button" onClick={() => onAnswer(v)}>
            {v}
            {defaultAnswer(q) === v && (
              <span className="badge recommended">recommended</span>
            )}
          </button>
        ))}
      </div>
    );
  }
  if (q.format === 'multi') {
    return (
      <div>
        <div className="option-list">
          {q.options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={picked.includes(o.key) ? 'primary' : ''}
              onClick={() =>
                setPicked((p) =>
                  p.includes(o.key)
                    ? p.filter((x) => x !== o.key)
                    : [...p, o.key],
                )
              }
            >
              {o.label}
              {o.recommended && (
                <span className="badge recommended">recommended</span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="primary"
          disabled={picked.length === 0}
          onClick={() => onAnswer(picked.join(','))}
        >
          Answer ({picked.length} selected)
        </button>
      </div>
    );
  }
  // single
  return (
    <div>
      <div className="option-list" aria-label="options">
        {q.options.map((o) => (
          <button key={o.key} type="button" onClick={() => onAnswer(o.key)}>
            {o.label}
            {o.recommended && (
              <span className="badge recommended">recommended</span>
            )}
          </button>
        ))}
      </div>
      {(q.allow_other || q.options.length === 0) && (
        <div className="row">
          <input
            aria-label="other answer"
            placeholder="Other…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <button
            type="button"
            disabled={!other.trim()}
            onClick={() => onAnswer(other.trim())}
          >
            Other
          </button>
        </div>
      )}
    </div>
  );
}

export default function Wizard() {
  const { ws = '', id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  const [state, setState] = useState<WizardState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const questions = useMemo(
    () => detail.data?.triage?.questions ?? [],
    [detail.data],
  );
  const wiz = state ?? initWizard(questions);
  const q = currentQuestion(wiz);
  const prog = progress(wiz);

  const submit = async (s: WizardState) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await client.answers(ws, id, {
        answers: answersPayload(s),
        expected_status: detail.data?.ticket.status,
      });
      navigate(`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`);
    } catch (e) {
      setSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const bail = async (action: 'force_ready' | 'wont_do') => {
    setSubmitting(true);
    try {
      await client.action(ws, id, {
        action,
        expected_status: detail.data?.ticket.status,
      });
      navigate(`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`);
    } catch (e) {
      setSubmitError(e);
      setSubmitting(false);
    }
  };

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <Empty />;

  const onAnswer = async (value: string | string[]) => {
    if (!q) return;
    const next = answer(wiz, q.id, value);
    setState(next);
    setSubmitError(null);
    try {
      await client.answers(ws, id, {
        id: q.id,
        answer: value,
        expected_status: detail.data?.ticket.status,
      });
    } catch (e) {
      setSubmitError(e);
    }
  };

  const onSkip = () => {
    if (!q) return;
    void onAnswer(defaultAnswer(q));
  };

  const onAcceptAll = async () => {
    const next = acceptAll(wiz);
    setState(next);
    await submit(next);
  };

  return (
    <section>
      <h1 className="page-title">Questions — {id}</h1>
      <p className="page-sub">
        <Link
          to={`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`}
        >
          ← ticket
        </Link>{' '}
        · answering clears the gate and re-runs triage
      </p>
      <div className="wizard-progress" aria-label="progress">
        <div
          style={{
            width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%`,
          }}
        />
      </div>
      <p className="muted">
        {prog.done} / {prog.total} resolved
      </p>
      {submitError != null && <ErrorBox error={submitError} />}
      {q ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{q.question}</h2>
          <p className="wizard-why">{q.why}</p>
          <OptionList q={q} state={wiz} onAnswer={(v) => void onAnswer(v)} />
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" onClick={onSkip} disabled={submitting}>
              Skip (accept: {defaultAnswer(q) || 'default'})
            </button>
            <span className="spacer" />
            <button
              type="button"
              onClick={() => void onAcceptAll()}
              disabled={submitting}
            >
              Accept all recommended
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <p>All questions resolved.</p>
          <button
            type="button"
            className="primary"
            disabled={submitting}
            onClick={() => void submit(wiz)}
          >
            {submitting ? 'Submitting…' : 'Submit answers'}
          </button>
        </div>
      )}
      <div className="row" style={{ marginTop: 20 }}>
        <span className="muted">Bail-outs:</span>
        <button
          type="button"
          className="small"
          disabled={submitting}
          onClick={() => void bail('force_ready')}
        >
          force-ready
        </button>
        <button
          type="button"
          className="small danger"
          disabled={submitting}
          onClick={() => void bail('wont_do')}
        >
          wont-do
        </button>
      </div>
    </section>
  );
}
