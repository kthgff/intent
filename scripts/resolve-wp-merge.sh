#!/usr/bin/env bash
# resolve-wp-merge.sh — resolve the mechanical conflicts wp branches cause:
# docs/exec/wp-*.md status lines and docs/TRACKER.md rows.
# Rule: prefer 'done' over 'in-progress' over 'todo'; dedupe tracker rows.
set -e
python3 - <<'PY'
import re, subprocess

conflicted = subprocess.run(
    ['git', 'diff', '--name-only', '--diff-filter=U'],
    capture_output=True, text=True).stdout.split()

def resolve(path):
    s = open(path).read()
    branch = subprocess.run(['git','rev-parse','--abbrev-ref','MERGE_HEAD'],
                            capture_output=True,text=True).stdout.strip() or 'MERGE_HEAD'
    def pick(m):
        head, theirs = m.group(1), m.group(2)
        # merge line-by-line: rows keyed on content minus status — prefer
        # the most-advanced status (done > in-progress > todo), keep both
        # sides' distinct rows.
        rank = {'done': 3, 'in-progress': 2, 'todo': 1}
        def key(l):
            return re.sub(r'\| (done|in-progress|todo|blocked|cut) \|?\s*$', '', l).strip()
        def status(l):
            for s in rank:
                if s in l: return s
            return None
        merged = {}
        order = []
        for l in theirs.split('\n') + head.split('\n'):
            if not l.strip(): continue
            k = key(l)
            st = status(l)
            if k in merged:
                if st and rank[st] > rank.get(merged[k][1], 0):
                    merged[k] = (l, st)
            else:
                merged[k] = (l, st); order.append(k)
        return '\n'.join(merged[k][0] for k in order) + '\n'
    s = re.sub(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n', pick, s, flags=re.S)
    # dedupe tracker table rows
    if path.endswith('TRACKER.md'):
        seen, out = set(), []
        for l in s.split('\n'):
            if l.startswith('| W') and l in seen: continue
            seen.add(l); out.append(l)
        s = '\n'.join(out)
    open(path, 'w').write(s)

for p in conflicted:
    if p.startswith('docs/'):
        resolve(p)
    else:
        # non-docs conflicts: prefer theirs (wp branch) — code they wrote
        subprocess.run(['git', 'checkout', '--theirs', p], check=True)
    subprocess.run(['git', 'add', p], check=True)
    print('resolved', p)
PY
git diff --name-only --diff-filter=U | grep . && echo "STILL CONFLICTED" || echo "all resolved"
