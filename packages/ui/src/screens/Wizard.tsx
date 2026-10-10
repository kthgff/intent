import type { TriageQuestion } from '@veto/core';
/**
 * S-04 — Q&A wizard. One question per card; options with `recommended`
 * badges; "Other…"; skip = accept; Accept-all; progress; bail-outs
 * (force-ready, wont-do). Serves triage needs-info, design-qa, and
 * interview follow-ups (shared component per UI-INVENTORY §3).
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { client } from '../api';
import { ConfirmDialog, Empty, ErrorBox, Loading } from '../components';
import { DictationField } from '../dictation';
import { useLoad } from '../hooks';
import { projectPath } from '../project';
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
  busy,
  onAnswer,
}: {
  q: TriageQuestion;
  state: WizardState;
  busy: boolean;
  onAnswer: (v: string) => void;
}) {
  const [other, setOther] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  if (q.format === 'text') {
    return (
      <div>
        <DictationField>
          <textarea
            aria-label="answer"
            value={other}
            disabled={busy}
            onChange={(e) => setOther(e.target.value)}
            placeholder={q.default ?? 'Type your answer…'}
          />
        </DictationField>
        <button
          type="button"
          className="primary"
          disabled={busy || !other.trim()}
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
        {[
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ].map((v) => (
          <button
            key={v.key}
            type="button"
            disabled={busy}
            onClick={() => onAnswer(v.key)}
          >
            {v.label}
            {defaultAnswer(q) === v.key && (
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
              disabled={busy}
              aria-pressed={picked.includes(o.key)}
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
          disabled={busy || picked.length === 0}
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
          <button
            key={o.key}
            type="button"
            disabled={busy}
            onClick={() => onAnswer(o.key)}
          >
            {o.label}
            {o.recommended && (
              <span className="badge recommended">recommended</span>
            )}
          </button>
        ))}
      </div>
      {(q.allow_other || q.options.length === 0) && (
        <div className="row">
          <DictationField>
            <input
              aria-label="other answer"
              placeholder="Other…"
              disabled={busy}
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          </DictationField>
          <button
            type="button"
            disabled={busy || !other.trim()}
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
  const [confirmBail, setConfirmBail] = useState<
    'force_ready' | 'wont_do' | null
  >(null);

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
      navigate(projectPath(ws, `/tickets/${encodeURIComponent(id)}`));
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
      navigate(projectPath(ws, `/tickets/${encodeURIComponent(id)}`));
    } catch (e) {
      setSubmitError(e);
      setSubmitting(false);
    }
  };

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <Empty />;

  const onAnswer = async (value: string | string[]) => {
    if (!q || submitting) return;
    const next = answer(wiz, q.id, value);
    setState(next);
    setSubmitting(true);
    setSubmitError(null);
    try {
      await client.answers(ws, id, {
        id: q.id,
        answer: value,
        expected_status: detail.data?.ticket.status,
      });
    } catch (e) {
      // Revert — the answer never landed; the UI must not claim it did.
      setSubmitError(e);
      setState(wiz);
    } finally {
      setSubmitting(false);
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
    <section className="wizard-screen">
      <h1 className="page-title">Questions — {id}</h1>
      <p className="page-sub">
        <Link to={projectPath(ws, `/tickets/${encodeURIComponent(id)}`)}>
          ← ticket
        </Link>{' '}
        · answering clears the gate and re-runs triage
      </p>
      <div
        className="wizard-progress"
        role="progressbar"
        aria-label="progress"
        aria-valuemin={0}
        aria-valuemax={prog.total}
        aria-valuenow={prog.done}
        aria-valuetext={`${prog.done} of ${prog.total} resolved`}
      >
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
          <OptionList
            q={q}
            state={wiz}
            busy={submitting}
            onAnswer={(v) => void onAnswer(v)}
          />
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
          title="Skip remaining questions and mark the ticket ready"
          disabled={submitting}
          onClick={() => setConfirmBail('force_ready')}
        >
          Force ready
        </button>
        <button
          type="button"
          className="small danger"
          title="Abandon this ticket entirely — leaves the pipeline"
          disabled={submitting}
          onClick={() => setConfirmBail('wont_do')}
        >
          Won't do
        </button>
      </div>
      {confirmBail === 'force_ready' && (
        <ConfirmDialog
          title="Force ready"
          body="Skips the remaining questions and marks the ticket ready without full triage."
          confirmLabel="Force ready"
          busy={submitting}
          onConfirm={() => {
            setConfirmBail(null);
            void bail('force_ready');
          }}
          onCancel={() => setConfirmBail(null)}
        />
      )}
      {confirmBail === 'wont_do' && (
        <ConfirmDialog
          title="Won't do"
          body="Marks this ticket as won't-do — it leaves the pipeline. The decision is recorded in the ledger."
          confirmLabel="Won't do"
          danger
          busy={submitting}
          onConfirm={() => {
            setConfirmBail(null);
            void bail('wont_do');
          }}
          onCancel={() => setConfirmBail(null)}
        />
      )}
    </section>
  );
}
