/**
 * Shared components (UI-INVENTORY §3): status stepper, kind badges,
 * markdown rendering, diff view, list states. Functional styling only.
 */
import type { GateKind } from '@sprint-runner/core';
import type { ReactNode } from 'react';

// ---------- list states ----------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <output className="state" style={{ display: 'block' }}>
      {label}
    </output>
  );
}

export function Empty({ label = 'Nothing here.' }: { label?: string }) {
  return <div className="state state-empty">{label}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="state state-error" role="alert">
      {msg}
    </div>
  );
}

// ---------- badges ----------

const KIND_LABEL: Record<string, string> = {
  question: 'Question',
  approval: 'Approval',
  review: 'Review',
  failure: 'Failure',
  escalation: 'Escalation',
  'split-plan': 'Split plan',
  repair: 'Repair',
};

export function KindBadge({ kind }: { kind: GateKind | string }) {
  return (
    <span className={`badge kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

export function SpecScore({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return null;
  const tone = score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad';
  return (
    <span className={`badge spec-${tone}`} title="spec score">
      spec {score}
    </span>
  );
}

// ---------- status stepper (S-05 header, queue chips) ----------

/** Pipeline display order — terminal/off-path statuses collapse. */
const STEPPER: string[] = [
  'imported',
  'triage',
  'needs-info',
  'ready',
  'prd-draft',
  'prd-review',
  'tdd-draft',
  'tdd-review',
  'test-draft',
  'test-review',
  'in-progress',
  'review',
  'approved',
  'pr-open',
  'ci-watch',
  'merged',
];

export function StatusStepper({ status }: { status: string }) {
  const idx = STEPPER.indexOf(status);
  const offPath = idx === -1;
  return (
    <ol className="stepper" aria-label={`status: ${status}`}>
      {STEPPER.map((s, i) => (
        <li
          key={s}
          className={`stepper-step${i < idx ? ' done' : ''}${
            s === status ? ' current' : ''
          }`}
        >
          {s}
        </li>
      ))}
      {offPath && <li className="stepper-step current offpath">{status}</li>}
    </ol>
  );
}

// ---------- markdown renderer (safe, minimal) ----------

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    );
}

/** Minimal markdown → HTML (headings, lists, code fences, paragraphs). */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let inCode = false;
  let inList = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br/>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flushPara();
      flushList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = (h[1] as string).length;
      out.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1] ?? '')}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="md"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by renderMarkdown
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

// ---------- diff viewer ----------

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@')
              ? 'diff-hunk'
              : '';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

// ---------- misc ----------

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

export function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
