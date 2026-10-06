/**
 * telemetry/sanitize.ts — the wp-120 ingest safety boundary
 * (INTELLIGENCE §6.1, D37 Phase C).
 *
 * Everything a connector receives is UNTRUSTED: log text can carry
 * secrets, PII, request bodies, and prompt-injection text. Redaction
 * and normalization happen here, BEFORE any DB row, embedding,
 * artifact, log, or model call — the functions are pure and total:
 * a payload that cannot be safely sanitized throws (fail-closed),
 * never passes through partially scrubbed.
 */
import { createHash } from 'node:crypto';
import { FINGERPRINT_VERSION } from '@veto/core';

/** The redaction-policy version recorded on telemetry_sources rows and
 *  stamped into `incident-investigation.json.sanitization_policy` —
 *  bump when the rule set changes so stored patterns stay attributable
 *  to the policy that produced them. */
export const TELEMETRY_REDACTION_POLICY = 'telemetry-redaction-v1';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// redaction — secrets, credentials, PII, request bodies
// ---------------------------------------------------------------------------

interface RedactionRule {
  re: RegExp;
  token: string;
}

/** Order matters: run the longest/most-specific patterns first so a
 *  partial earlier rule can't mangle the evidence a later one anchors
 *  on (e.g. a JWT before an `Authorization:` header). */
const REDACTION_RULES: RedactionRule[] = [
  // Authorization / credential headers and key=value secrets.
  {
    re: /(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,"'}]+/gi,
    token: '<redacted:auth>',
  },
  {
    re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|session|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi,
    token: '<redacted:credential>',
  },
  // JWTs and opaque bearer-style tokens (three b64url segments).
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    token: '<redacted:jwt>',
  },
  // PEM private-key material.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    token: '<redacted:private-key>',
  },
  // Emails (PII).
  { re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, token: '<redacted:email>' },
  // Credit-card-ish 13–19 digit runs (PII/payment data). Run before
  // generic numerics so we never half-redact a PAN.
  {
    re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g,
    token: '<redacted:card>',
  },
  // IPv4 literals (network PII/topology).
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, token: '<redacted:ip>' },
];

/** Keys whose VALUES are dropped wholesale — request/response bodies
 *  and header bags are never fingerprint inputs; INTELLIGENCE §6.1
 *  redacts request bodies unconditionally. */
const BODY_KEYS = new Set([
  'body',
  'request_body',
  'response_body',
  'payload',
  'headers',
  'request_headers',
  'response_headers',
  'cookies',
]);

/** Keys whose VALUES are credentials by name — the value is dropped
 *  regardless of content (a bare `authorization` value carries no
 *  `Authorization:` prefix to redact). Checked before identity keys. */
const SECRET_VALUE_KEYS =
  /^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|session|cookie|set-cookie|ssn|credit[_-]?card)$/i;

/** Attribute keys whose values are preserved verbatim for clustering —
 *  the exception class / error code / service / deployment identity
 *  INTELLIGENCE §6.1 requires normalization NOT to erase. */
export const IDENTITY_KEYS = [
  'exception_class',
  'error_class',
  'error_code',
  'service',
  'service_name',
  'resource',
  'version',
  'release',
  'environment',
] as const;

/** Normalize one string scalar: redact secrets/PII, then replace
 *  variable values (quoted strings with variable content, UUIDs,
 *  hex ids, large numerics, timestamps) with stable placeholders so
 *  "user 42 not found" and "user 99 not found" cluster together. */
export function normalizeValue(text: string): string {
  let out = text;
  for (const { re, token } of REDACTION_RULES) {
    out = out.replaceAll(re, token);
  }
  return out
    .replaceAll(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<uuid>',
    )
    .replaceAll(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g,
      '<ts>',
    )
    .replaceAll(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replaceAll(/\b[0-9a-f]{32,}\b/gi, '<hex>')
    .replaceAll(/\b\d+\b/g, '<n>')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize an arbitrary attribute map. Body/header keys drop to a
 * marker; identity keys keep their (normalized) values; everything
 * else is normalized recursively (bounded depth/size).
 */
export function sanitizeAttributes(
  attrs: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 3) return { _truncated: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.toLowerCase();
    if (BODY_KEYS.has(key)) {
      out[k] = '<redacted:body>';
      continue;
    }
    if (SECRET_VALUE_KEYS.test(key)) {
      out[k] = '<redacted:credential>';
      continue;
    }
    // Identity attributes: redact secrets/PII but NEVER collapse the
    // value to a placeholder — version/service/deployment identity
    // must survive normalization (INTELLIGENCE §6.1 step 3).
    if (
      (IDENTITY_KEYS as readonly string[]).includes(key) &&
      typeof v === 'string'
    ) {
      let s = v.slice(0, 1024);
      for (const { re, token } of REDACTION_RULES) {
        s = s.replaceAll(re, token);
      }
      out[k] = s;
      continue;
    }
    if (typeof v === 'string') {
      out[k] = normalizeValue(v.slice(0, 4096));
    } else if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v
        .slice(0, 50)
        .map((x) =>
          typeof x === 'string' ? normalizeValue(x.slice(0, 1024)) : x,
        );
    } else if (typeof v === 'object') {
      out[k] = sanitizeAttributes(v as Record<string, unknown>, depth + 1);
    }
  }
  return out;
}

/**
 * Sanitize one incoming telemetry event — the ONLY path from wire to
 * store. Returns a normalized record; throws on a payload with no
 * usable content (fail-closed — an unclassifiable event must not leak
 * into a signature).
 */
export interface TelemetryEvent {
  message?: string;
  exception_class?: string;
  error_code?: string;
  stack?: string[];
  attributes?: Record<string, unknown>;
  timestamp?: string;
}

export interface SanitizedEvent {
  message: string;
  exception_class: string | null;
  error_code: string | null;
  frames: string[];
  attributes: Record<string, unknown>;
  timestamp: string | null;
}

const MAX_FRAMES = 20;
const MAX_REPRESENTATIVE = 2000;

/** Redact-only normalization for identity fields (exception class,
 *  error code): secrets/PII scrubbed, but no variable-value
 *  collapsing — `NPE-1001` must stay `NPE-1001`. */
function redactIdentity(text: string, max: number): string {
  let out = text.slice(0, max);
  for (const { re, token } of REDACTION_RULES) {
    out = out.replaceAll(re, token);
  }
  return out;
}

export function sanitizeTelemetryEvent(event: TelemetryEvent): SanitizedEvent {
  if (typeof event !== 'object' || event === null) {
    throw new Error('telemetry event is not an object — refused (fail-closed)');
  }
  const message = normalizeValue(String(event.message ?? '')).slice(
    0,
    MAX_REPRESENTATIVE,
  );
  const exceptionClass = event.exception_class
    ? redactIdentity(String(event.exception_class), 200)
    : null;
  const errorCode = event.error_code
    ? redactIdentity(String(event.error_code), 100)
    : null;
  const frames = (event.stack ?? [])
    .slice(0, MAX_FRAMES)
    .map((f) => normalizeValue(String(f)).slice(0, 300));
  const attributes = sanitizeAttributes(event.attributes ?? {});
  if (!message && !exceptionClass && !errorCode && frames.length === 0) {
    throw new Error(
      'telemetry event has no classifiable content after sanitization — refused (fail-closed)',
    );
  }
  return {
    message,
    exception_class: exceptionClass,
    error_code: errorCode,
    frames,
    attributes,
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
  };
}

// ---------------------------------------------------------------------------
// fingerprint — stable cluster key (INTELLIGENCE §6.1 step 4)
// ---------------------------------------------------------------------------

/**
 * The fingerprint input deliberately EXCLUDES timestamps, trace/span
 * ids, request ids, deployment ids, emails, and normalized-out
 * variable values — and deliberately INCLUDES exception class, error
 * code, top frames, service, and version/environment identity so
 * deceptively similar failures in different services or versions do
 * NOT cluster together (wp-120 test plan). Deployment identity is
 * preserved in attributes for investigation but excluded from the
 * fingerprint — a deploy bump must not re-cluster a recurring
 * pattern into a new signature (correlation is investigate's job).
 */
export function fingerprintEvent(ev: SanitizedEvent): string {
  const identity: string[] = [];
  for (const k of IDENTITY_KEYS) {
    const v = ev.attributes[k];
    if (typeof v === 'string' && v.length > 0 && !v.startsWith('<redacted')) {
      identity.push(`${k}=${v}`);
    }
  }
  const material = [
    ev.exception_class ?? '',
    ev.error_code ?? '',
    ev.message,
    ...ev.frames.slice(0, 5),
    ...identity.sort(),
  ].join('\n');
  return sha256(material).slice(0, 24);
}

/** Bounded sanitized representative — a capped single-line sample of
 *  the pattern, safe to store/embed. */
export function representativeSample(ev: SanitizedEvent): string {
  const parts = [
    ev.exception_class,
    ev.error_code,
    ev.message,
    ev.frames[0] ? `at ${ev.frames[0]}` : null,
  ].filter((p): p is string => !!p);
  return parts.join(' | ').slice(0, MAX_REPRESENTATIVE);
}

/** Deterministic signature row id (the dedupe key rides the UNIQUE
 *  constraint; the id is just its hash). */
export function signatureId(
  workspace: string,
  sourceId: string,
  fingerprint: string,
): string {
  return `errsig_${sha256(`${workspace}|${sourceId}|${FINGERPRINT_VERSION}|${fingerprint}`).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// source-config hygiene — secret NAMES/REFS only, never values
// ---------------------------------------------------------------------------

const SECRETISH_KEY =
  /token|secret|password|passwd|credential|api[_-]?key|private[_-]?key/i;
const REF_VALUE = /^(env:|ref:|\$\{?[A-Z][A-Z0-9_]*\}?$)/;

/**
 * Fail-closed source-config check: any key that LOOKS like a secret
 * must carry a name/ref (`env:FOO`, `ref:…`, `$FOO`), never a literal
 * value (DB-SCHEMA: `config` stores secret refs only). Returns issues;
 * callers throw on a non-empty list.
 */
export function secretConfigIssues(config: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (!SECRETISH_KEY.test(k)) continue;
    if (typeof v !== 'string' || !REF_VALUE.test(v.trim())) {
      issues.push(
        `config key '${k}' must hold a secret REF (env:NAME / ref:… / $NAME), not a value`,
      );
    }
  }
  return issues;
}
