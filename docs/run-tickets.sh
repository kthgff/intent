#!/usr/bin/env bash
#
# run-tickets.sh — feed sprint ticket .md files to Devin CLI, one at a time.
#
# Each ticket is a Markdown file with YAML frontmatter:
#   ---
#   id: ABC-123
#   title: Short title
#   status: todo          # todo | in-progress | done | failed | blocked
#   priority: high        # high | medium | low
#   repo: backend         # must match a name in repos.conf
#   model: opus           # optional: --model override for this ticket
#   ---
#
# The runner:
#   1. collects tickets/*.md with status != done, sorted by priority
#   2. resolves each ticket's repo via repos.conf (name=/abs/path)
#   3. creates/checks out branch ticket/<id> in that repo
#   4. renders prompt-template.md into runs/<id>/prompt.md
#   5. runs `devin -p <prompt>` non-interactively from the repo directory
#   6. marks the ticket done if the log ends with `PR: <url>`, else failed
#
# Usage:
#   ./run-tickets.sh                  # run every unfinished ticket
#   ./run-tickets.sh --dry-run        # show the plan, change nothing
#   ./run-tickets.sh --ticket ABC-123 # run a single ticket
#   ./run-tickets.sh --max 3          # run at most 3 tickets
#   ./run-tickets.sh --force          # re-run tickets marked done
#   ./run-tickets.sh --sprint DIR     # use a different sprint directory
#
# Environment overrides:
#   DEVIN_BIN           path to the devin binary (default: devin on PATH,
#                       falls back to the Devin.app bundled binary)
#   PERMISSION_MODE     devin --permission-mode (default: bypass)
#   TICKET_TIMEOUT      seconds before a devin run is killed (default: 7200)
#   SPRINT_DIR          default sprint directory
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPRINT_DIR="${SPRINT_DIR:-$SCRIPT_DIR/sprints/2026-10}"
TEMPLATE="$SCRIPT_DIR/prompt-template.md"
PERMISSION_MODE="${PERMISSION_MODE:-bypass}"
TICKET_TIMEOUT="${TICKET_TIMEOUT:-7200}"
BRANCH_PREFIX="ticket"

DRY_RUN=""
ONLY_TICKET=""
MAX=""
FORCE=""

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^#\{1,2\} \{0,1\}//; /^set -euo/d'; }

# --- args -------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1 ;;
    --ticket)         ONLY_TICKET="$2"; shift ;;
    --max)            MAX="$2"; shift ;;
    --force)          FORCE=1 ;;
    --sprint)         SPRINT_DIR="$2"; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

TICKETS_DIR="$SPRINT_DIR/tickets"
RUNS_DIR="$SPRINT_DIR/runs"
REPOS_CONF="$SPRINT_DIR/repos.conf"
SPRINT_FILE="$SPRINT_DIR/sprint.md"

[ -d "$TICKETS_DIR" ]   || die "no tickets dir: $TICKETS_DIR"
[ -f "$REPOS_CONF" ]    || die "no repos.conf: $REPOS_CONF"
[ -f "$SPRINT_FILE" ]   || die "no sprint.md: $SPRINT_FILE"
[ -f "$TEMPLATE" ]      || die "no prompt template: $TEMPLATE"

# --- devin binary -----------------------------------------------------------

DEVIN="${DEVIN_BIN:-}"
if [ -z "$DEVIN" ]; then
  if command -v devin >/dev/null 2>&1; then
    DEVIN="devin"
  elif [ -x "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin" ]; then
    DEVIN="/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
  else
    die "devin binary not found (set DEVIN_BIN)"
  fi
fi

if [ -z "$DRY_RUN" ]; then
  auth_out="$("$DEVIN" auth status 2>&1)" \
    || die "devin auth status failed — run: $DEVIN auth login"
  printf '%s' "$auth_out" | grep -qiE 'not logged in|unauthenticated|no credentials' \
    && die "devin is not authenticated — run: $DEVIN auth login"
fi

# --- frontmatter helpers ----------------------------------------------------

fm_get() { # fm_get <file> <key> -> value (first match inside --- block)
  awk -v k="$2" '
    /^---[[:space:]]*$/ { f++; next }
    f == 1 && $0 ~ "^" k ":" {
      sub("^" k ":[[:space:]]*", "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print; exit
    }
    f >= 2 { exit }
  ' "$1"
}

fm_set() { # fm_set <file> <key> <value> — set/insert key inside --- block
  local tmp; tmp="$(mktemp)"
  awk -v k="$2" -v v="$3" '
    /^---[[:space:]]*$/ {
      f++
      if (f == 2 && !done) print k ": " v
      print; next
    }
    f == 1 && $0 ~ "^" k ":" { if (!done) { print k ": " v; done=1 } next }
    { print }
  ' "$1" > "$tmp" && mv "$tmp" "$1"
}

# --- tickets ----------------------------------------------------------------

collect_tickets() { # emits "rank<TAB>file" sorted by rank
  local f status pri rank
  for f in "$TICKETS_DIR"/*.md; do
    [ -e "$f" ] || continue
    status="$(fm_get "$f" status)"; status="${status:-todo}"
    if [ "$status" = "done" ] && [ -z "$FORCE" ]; then continue; fi
    pri="$(fm_get "$f" priority)"
    case "$(printf '%s' "$pri" | tr 'A-Z' 'a-z')" in
      high)            rank=0 ;;
      medium|med)      rank=1 ;;
      low)             rank=2 ;;
      *)               rank=3 ;;
    esac
    printf '%s\t%s\n' "$rank" "$f"
  done | sort -n -k1,1
}

repo_path() { # repo_path <name> -> /abs/path from repos.conf
  awk -F= -v n="$1" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      name=$1; sub(/=.*/, "", name); gsub(/[[:space:]]/, "", name)
      if (name == n) { sub(/^[^=]*=/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }
    }
  ' "$REPOS_CONF"
}

render_prompt() { # render_prompt <ticket_file> <out> — env: RID REPO_NAME BRANCH
  awk -v id="$RID" -v repo="$REPO_NAME" -v branch="$BRANCH" \
      -v sprint="$SPRINT_FILE" -v ticketfile="$1" '
    /^[[:space:]]*\{\{SPRINT_MD\}\}[[:space:]]*$/  { while ((getline l < sprint) > 0) print l; next }
    /^[[:space:]]*\{\{TICKET_MD\}\}[[:space:]]*$/ { while ((getline l < ticketfile) > 0) print l; next }
    {
      gsub(/\{\{TICKET_ID\}\}/, id)
      gsub(/\{\{REPO_NAME\}\}/, repo)
      gsub(/\{\{BRANCH\}\}/, branch)
      print
    }
  ' "$TEMPLATE" > "$2"
}

# --- run one ticket ---------------------------------------------------------

devin_run() { # devin_run <repo> <run_dir> [extra devin args...]
  local repo=$1 run_dir=$2; shift 2
  (cd "$repo" && "$DEVIN" "$@" -p "$(cat "$run_dir/prompt.md")" \
    --permission-mode "$PERMISSION_MODE" \
    --respect-workspace-trust false \
    --export "$run_dir/export.json")
}

run_with_timeout() { # run_with_timeout <secs> <cmd...> — returns 124 on timeout
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs" 2>/dev/null; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  [ "$rc" -eq 143 ] && return 124
  return "$rc"
}

count=0 ok=0 failed=0 blocked=0
run_ticket() { # run_ticket <file>
  local file="$1" id title repo_name repo branch model run_dir prompt rc pr reason

  id="$(fm_get "$file" id)";          id="${id:-$(basename "$file" .md)}"
  title="$(fm_get "$file" title)";    title="${title:-$id}"
  repo_name="$(fm_get "$file" repo)"
  model="$(fm_get "$file" model)"
  branch="$BRANCH_PREFIX/$(printf '%s' "$id" | tr 'A-Z' 'a-z')"
  run_dir="$RUNS_DIR/$id"

  [ -n "$repo_name" ] || { warn "$id: no repo field — marking blocked"; \
    [ -z "$DRY_RUN" ] && fm_set "$file" status blocked; return 1; }

  repo="$(repo_path "$repo_name")"

  if [ -n "$DRY_RUN" ]; then
    local missing=""
    { [ -z "$repo" ] || [ ! -d "$repo" ]; } && missing="  [repo unresolved/missing]"
    log "  $id  [$repo_name -> ${repo:-?}]  branch=$branch  ${model:+model=$model}  \"$title\"$missing"
    return 0
  fi

  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    warn "$id: repo '$repo_name' not in repos.conf or missing on disk — marking blocked"
    fm_set "$file" status blocked; return 1
  fi

  mkdir -p "$run_dir"
  fm_set "$file" status in-progress

  # repo must be a clean git worktree before we branch
  if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "$id: $repo is not a git repo — marking blocked"
    fm_set "$file" status blocked; return 1
  fi
  if [ -n "$(git -C "$repo" status --porcelain)" ]; then
    warn "$id: $repo has uncommitted changes — marking blocked"
    fm_set "$file" status blocked; return 1
  fi

  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" checkout "$branch" >/dev/null 2>&1
  else
    git -C "$repo" checkout -b "$branch" >/dev/null 2>&1
  fi || { warn "$id: could not checkout $branch — marking failed"; \
          fm_set "$file" status failed; return 1; }

  RID="$id" REPO_NAME="$repo_name" BRANCH="$branch" \
    render_prompt "$file" "$run_dir/prompt.md"

  log "==> $id  ($repo_name)  branch=$branch"
  rc=0
  extra=(); [ -n "$model" ] && extra=(--model "$model")
  run_with_timeout "$TICKET_TIMEOUT" devin_run "$repo" "$run_dir" "${extra[@]}" \
    >"$run_dir/devin.log" 2>&1 || rc=$?

  pr="$(grep -oE '^PR:[[:space:]]*https?://[^[:space:]]+' "$run_dir/devin.log" | tail -1 | sed 's/^PR:[[:space:]]*//' || true)"
  reason="$(grep -oE 'BLOCKED: .*' "$run_dir/devin.log" | tail -1 | sed 's/^BLOCKED: //' || true)"

  # stash session list for manual follow-up via `devin -r <id>`
  (cd "$repo" && "$DEVIN" list --format json >"$run_dir/sessions.json" 2>/dev/null) || true

  if [ -n "$pr" ]; then
    printf '%s\n' "$pr" > "$run_dir/pr-url.txt"
    fm_set "$file" status done
    log "    done  $pr"
  elif [ -n "$reason" ]; then
    printf '%s\n' "$reason" > "$run_dir/blocked-reason.txt"
    fm_set "$file" status blocked
    log "    blocked  $reason"
  else
    printf 'exit=%s\n' "$rc" > "$run_dir/failed.txt"
    [ "$rc" -eq 124 ] && printf 'timeout=%ss\n' "$TICKET_TIMEOUT" >> "$run_dir/failed.txt"
    fm_set "$file" status failed
    log "    FAILED (exit=$rc) — see $run_dir/devin.log"
  fi
}

# --- main -------------------------------------------------------------------

log "Sprint:  $SPRINT_DIR"
log "Devin:   $DEVIN"
log "Mode:    --permission-mode $PERMISSION_MODE"
[ -n "$DRY_RUN" ] && log "DRY RUN — no changes will be made"
log ""

if [ -n "$ONLY_TICKET" ]; then
  match=""
  for f in "$TICKETS_DIR"/*.md; do
    [ -e "$f" ] || continue
    [ "$(fm_get "$f" id)" = "$ONLY_TICKET" ] && { match="$f"; break; }
    [ "$(basename "$f" .md)" = "$ONLY_TICKET" ] && { match="$f"; break; }
  done
  [ -n "$match" ] || die "no ticket matches '$ONLY_TICKET'"
  log "Running single ticket:"
  run_ticket "$match" || true
  exit 0
fi

log "Queued tickets (priority order):"
while IFS=$'\t' read -r _rank file; do
  [ -n "$file" ] || continue
  [ -n "$MAX" ] && [ "$count" -ge "$MAX" ] && break
  if [ -n "$DRY_RUN" ]; then
    run_ticket "$file"
    count=$((count + 1))
  else
    run_ticket "$file" || true
    case "$(fm_get "$file" status)" in
      done)              ok=$((ok + 1)) ;;
      failed)            failed=$((failed + 1)) ;;
      blocked|blocked:*) blocked=$((blocked + 1)) ;;
    esac
    count=$((count + 1))
  fi
done < <(collect_tickets)

[ "$count" -eq 0 ] && log "  (nothing to do — all tickets done)"
log ""
log "Processed $count ticket(s): $ok done, $failed failed, $blocked blocked."
log "Status is recorded in each ticket's frontmatter."
