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
        lines = (head + theirs).split('\n')
        # prefer lines containing done/in-progress/todo in that order
        for want in ('| done |', 'status: done', '| in-progress |', 'status: in-progress'):
            for l in lines:
                if want in l:
                    return l + ('\n' if l.startswith('|') else '')
        # default: union, theirs first
        out, seen = [], set()
        for l in theirs.split('\n') + head.split('\n'):
            if l and l not in seen:
                seen.add(l); out.append(l)
        return '\n'.join(out) + '\n'
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
