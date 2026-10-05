/**
 * Minimal unified-ish line diff for doc_versions (API.md S-06:
 * "rendered … + version diffs"). LCS-based — emits `-`/`+` runs
 * bracketed by `@@` hunk markers; enough for the UI's DiffView to
 * render adds/dels. Not a full Myers implementation — docs are small
 * and this is a display aid, not a merge tool.
 */
export function lineDiff(from: string, to: string): string {
  const a = from.split('\n');
  const b = to.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS table (docs are ≤ a few hundred lines — O(n·m) is fine).
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = dp.at(i);
    const below = dp.at(i + 1);
    if (!row || !below) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (below.at(j + 1) ?? 0) + 1
          : Math.max(below.at(j) ?? 0, row.at(j + 1) ?? 0);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  let inHunk = false;
  const hunk = () => {
    if (!inHunk) {
      out.push('@@');
      inHunk = true;
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (inHunk) {
        out.push(` ${a[i]}`);
      }
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      hunk();
      out.push(`-${a[i]}`);
      i++;
    } else {
      hunk();
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    hunk();
    out.push(`-${a[i]}`);
    i++;
  }
  while (j < m) {
    hunk();
    out.push(`+${b[j]}`);
    j++;
  }
  return out.join('\n');
}
