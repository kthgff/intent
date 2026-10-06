/**
 * security-findings lint — PRD §15.8 security dimension (wp-150).
 *
 * A security finding must carry the full field set the dimension
 * depends on: `security_category` (the wp-131 taxonomy) and
 * `affected_asset`. The lint is fail-closed: a finding flagged
 * `category: security` that omits them is a violation, never a silent
 * pass — the review gate cannot assess what it cannot read.
 *
 * Pure functions: findings in → violations out. Shared by the runner
 * (review merge) and the conductor security engine so both agree on
 * what "a well-formed security finding" means.
 */
import { SECURITY_CATEGORIES } from '@veto/core';
import type { LintViolation } from './coverage.js';

/** Loose shape — findings arrive as parsed JSON, not trusted rows. */
interface LooseFinding {
  thread_id?: unknown;
  category?: unknown;
  security_category?: unknown;
  affected_asset?: unknown;
  file?: unknown;
}

function isSecurity(f: LooseFinding): boolean {
  return f.category === 'security' || f.security_category != null;
}

/** Stable label for a finding in a violation message. */
function label(f: LooseFinding, i: number): string {
  const id =
    typeof f.thread_id === 'string' && f.thread_id !== ''
      ? f.thread_id
      : `#${i}`;
  return id;
}

/**
 * Lint a set of review findings (a merged `review.json` array or a
 * `findings-<pass>.json` fragment). Non-security findings are ignored.
 */
export function securityFindingLint(findings: unknown): LintViolation[] {
  if (!Array.isArray(findings)) {
    return [
      {
        rule: 'security.malformed',
        message: 'security findings: expected a JSON array — fail-closed',
      },
    ];
  }
  const violations: LintViolation[] = [];
  findings.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') return;
    const f = raw as LooseFinding;
    if (!isSecurity(f)) return;
    const id = label(f, i);
    if (f.security_category == null) {
      violations.push({
        rule: 'security.missing-category',
        message: `security finding ${id} is missing security_category ∉ {${SECURITY_CATEGORIES.join(', ')}}`,
      });
    } else if (
      typeof f.security_category !== 'string' ||
      !(SECURITY_CATEGORIES as readonly string[]).includes(f.security_category)
    ) {
      violations.push({
        rule: 'security.bad-category',
        message: `security finding ${id} has security_category '${String(
          f.security_category,
        )}' ∉ {${SECURITY_CATEGORIES.join(', ')}}`,
      });
    }
    const asset = f.affected_asset ?? f.file;
    if (asset == null || (typeof asset === 'string' && asset.trim() === '')) {
      violations.push({
        rule: 'security.missing-asset',
        message: `security finding ${id} is missing affected_asset`,
      });
    }
  });
  return violations;
}
