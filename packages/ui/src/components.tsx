/**
 * Shared components (UI-INVENTORY §3): kind/status badges, tabs, modal
 * + confirm dialog, markdown rendering, diff view, list states.
 * Functional styling only.
 */
import type { GateKind } from '@veto/core';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
} from 'react';
import { useEscapeKey } from './hooks';

// ---------- list states ----------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <output className="state" style={{ display: 'block' }}>
      <span className="spinner" aria-hidden="true" />
      {label}
    </output>
  );
}

export function Empty({
  label = 'Nothing here.',
  action,
}: {
  label?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-empty">
      <div>{label}</div>
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

const ERROR_LABEL: Record<string, string> = {
  not_found: "Couldn't load this.",
  conflict: 'That conflicts with current state — reload and retry.',
  unauthorized: 'Not authorized — re-open the app with a valid token.',
  forbidden: 'Not authorized — re-open the app with a valid token.',
  clone_failed: 'Clone failed — check the repository URL and path.',
  validation_failed: 'The request was rejected — check the fields.',
  offline: 'The conductor is unreachable — is the daemon running?',
};

export function ErrorBox({
  error,
  onRetry,
  onDismiss,
}: {
  error: unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const msg = error instanceof Error ? error.message : String(error);
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
      ? ((error as { code: string }).code ?? null)
      : null;
  const friendly = code ? ERROR_LABEL[code] : undefined;
  return (
    <div className="state state-error" role="alert">
      <div>{friendly ?? msg}</div>
      {(friendly || code) && (
        <div className="card-meta" style={{ marginTop: 6 }}>
          {friendly && friendly !== msg && <span>{msg} </span>}
          {code && <span className="badge spec-dim">{code}</span>}
        </div>
      )}
      {(onRetry || onDismiss) && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          {onRetry && (
            <button type="button" className="small" onClick={onRetry}>
              Retry
            </button>
          )}
          {onDismiss && (
            <button type="button" className="small" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- labels: machine strings → human copy ----------

/** kebab/snake machine ids → "Human readable". */
export function humanize(s: string): string {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Abbreviation overrides — everything else falls back to humanize(). */
const STATUS_LABEL: Record<string, string> = {
  'needs-info': 'Needs info',
  'prd-draft': 'PRD draft',
  'prd-review': 'PRD review',
  'prd-approved': 'PRD approved',
  'design-qa': 'Design QA',
  'tdd-draft': 'TDD draft',
  'tdd-review': 'TDD review',
  'tdd-approved': 'TDD approved',
  'in-progress': 'In progress',
  'changes-requested': 'Changes requested',
  'pr-open': 'PR open',
  'ci-watch': 'CI watch',
  'wont-do': "Won't do",
  verify_failed: 'Verify failed',
  merge_conflict: 'Merge conflict',
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? humanize(s);
}

/** Gate ids overlap status vocabulary — reuse the same mapping. */
export function gateLabel(g: string): string {
  return statusLabel(g);
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
  verify: 'Verify',
};

export function KindBadge({ kind }: { kind: GateKind | string }) {
  return (
    <span className={`badge kind-${kind}`}>
      {KIND_LABEL[kind] ?? humanize(kind)}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status}`}>{statusLabel(status)}</span>
  );
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

// ---------- tabs (full ARIA: roving tabindex + arrow keys) ----------

export interface TabDef {
  id: string;
  label: ReactNode;
}

export function Tabs({
  tabs,
  active,
  onChange,
  ariaLabel,
  inline,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  /** Render without the bottom border — used beside page titles. */
  inline?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.id === active);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft')
      next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const id = tabs[next]?.id;
    if (id === undefined) return;
    onChange(id);
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
      [next]?.focus();
  };
  return (
    <div
      className={`tabs${inline ? ' tabs-inline' : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      ref={listRef}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={t.id === active}
          aria-controls={`tabpanel-${t.id}`}
          tabIndex={t.id === active ? 0 : -1}
          className={t.id === active ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      className="tab-panel"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabs — panel is focusable so its scrollable content is keyboard-reachable
      tabIndex={0}
    >
      {children}
    </div>
  );
}

// ---------- modal + confirm dialog (focus trap, restore, Escape) ----------

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [data-autofocus]';

export function Modal({
  label,
  onClose,
  children,
  wide,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** 560px instead of 380px — for forms/diffs. */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  useEscapeKey(true, onClose);
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    const target =
      el.querySelector<HTMLElement>('[data-autofocus]') ??
      el.querySelector<HTMLElement>('input, textarea, select') ??
      el.querySelector<HTMLElement>(FOCUSABLE) ??
      el;
    target.focus();
    return () => restoreRef.current?.focus?.();
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Escape must reach the window-level handler; swallowing every
    // keydown here blocked the backdrop's handler.
    e.stopPropagation();
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!els || els.length === 0) return;
    const list = Array.from(els).filter(
      (x) => x.offsetParent !== null || x === document.activeElement,
    );
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      last?.focus();
      e.preventDefault();
    } else if (!e.shiftKey && active === last) {
      first?.focus();
      e.preventDefault();
    }
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Esc closes via the dialog's onKeyDown
    <div className="modal-back" role="presentation" onClick={onClose}>
      <dialog
        open
        ref={ref}
        className="modal"
        style={wide ? { width: 560 } : undefined}
        aria-label={label}
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </dialog>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal label={title} onClose={onCancel}>
      <strong>{title}</strong>
      {body && <p className="muted">{body}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
          data-autofocus={danger ? undefined : true}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-autofocus={danger ? true : undefined}
        >
          Cancel
        </button>
      </div>
    </Modal>
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

export function DiffView({
  diff,
  header,
}: {
  diff: string;
  header?: string;
}) {
  return (
    <div className="diff-view">
      {header && <div className="diff-head muted">{header}</div>}
      <pre className="diff">
      {diff.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('diff ') ||
          line.startsWith('index ')
            ? 'diff-meta'
            : line.startsWith('+')
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
    </div>
  );
}

// ---------- misc ----------

export function Field({
  label,
  id,
  children,
}: {
  label: string;
  /** Optional control id — otherwise generated. */
  id?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const control =
    isValidElement(children) && !children.props.id
      ? cloneElement(children as ReactElement<{ id?: string }>, {
          id: fieldId,
        })
      : children;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        {label}
      </label>
      {control}
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
