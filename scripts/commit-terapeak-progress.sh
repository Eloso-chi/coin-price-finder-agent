#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

DRY_RUN=false
RUN_ID_OVERRIDE=""
STATE_FILE=""
PASSES_FILE="cache/terapeak-runs/passes.jsonl"
GH_BIN="${GH_BIN:-gh}"
REPO_OVERRIDE=""
export GIT_TERMINAL_PROMPT=0

usage() {
  cat <<'EOF'
Usage: bash scripts/commit-terapeak-progress.sh [options]

Options:
  --dry-run             Print the branch, commit, files, and PR plan only
  --run-id ID           Use an explicit run ID instead of operator state
  --state-file PATH     Read run ID from a specific operator state file
  --passes-file PATH    Read pass totals from this JSONL file
  --gh-bin PATH         Use this GitHub CLI executable (default: gh)
  --repo OWNER/REPO     Override the GitHub repository derived from origin
  -h, --help            Show this help
EOF
}

fail() {
  echo "[terapeak-progress:FAIL] $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --run-id) RUN_ID_OVERRIDE="${2:-}"; shift 2 ;;
    --state-file) STATE_FILE="${2:-}"; shift 2 ;;
    --passes-file) PASSES_FILE="${2:-}"; shift 2 ;;
    --gh-bin) GH_BIN="${2:-}"; shift 2 ;;
    --repo) REPO_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

command -v git >/dev/null 2>&1 || fail "git is required"
PYTHON_BIN="$(command -v python3 || command -v python || true)"
[[ -n "$PYTHON_BIN" ]] || fail "python3 or python is required"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not inside a Git worktree"

if [[ -z "$STATE_FILE" ]]; then
  if [[ -f cache/terapeak-operator-codespace.state.json ]]; then
    STATE_FILE="cache/terapeak-operator-codespace.state.json"
  elif [[ -f cache/terapeak-startup-state.json ]]; then
    STATE_FILE="cache/terapeak-startup-state.json"
  fi
fi

if [[ -n "$RUN_ID_OVERRIDE" ]]; then
  RUN_ID="$RUN_ID_OVERRIDE"
else
  [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]] || fail "No operator state file found; pass --state-file or --run-id"
  RUN_ID="$($PYTHON_BIN - "$STATE_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    state = json.load(handle)
print(state.get("run_id") or state.get("runId") or "")
PY
)" || fail "Could not read operator state: $STATE_FILE"
fi

[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "Invalid or missing run ID"
[[ -f "$PASSES_FILE" ]] || fail "Pass telemetry not found: $PASSES_FILE"

STATS="$($PYTHON_BIN - "$PASSES_FILE" "$RUN_ID" <<'PY'
import json
import sys

path, run_id = sys.argv[1:3]
totals = {
    "passes": 0,
    "attempted": 0,
    "succeeded": 0,
    "empty": 0,
    "failed": 0,
    "new_rows": 0,
    "dup_rows": 0,
}

with open(path, encoding="utf-8") as handle:
    for line_number, line in enumerate(handle, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(f"invalid JSON on pass telemetry line {line_number}: {error}")
        if record.get("run_id") != run_id:
            continue
        totals["passes"] += 1
        values = {}
        for field in totals:
            if field != "passes":
                value = record.get(field, 0)
                if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 1_000_000_000:
                    raise SystemExit(f"invalid {field} on pass telemetry line {line_number}")
                values[field] = value
                totals[field] += value
        if values["attempted"] != values["succeeded"] + values["empty"] + values["failed"]:
            raise SystemExit(f"outcomes do not equal attempted on pass telemetry line {line_number}")

if totals["passes"] == 0:
    raise SystemExit(f"no pass telemetry found for run {run_id}")

print("\t".join(str(totals[field]) for field in totals))
PY
)" || fail "Could not aggregate pass telemetry for run $RUN_ID"

IFS=$'\t' read -r PASS_COUNT ATTEMPTED SUCCEEDED EMPTY FAILED NEW_ROWS DUP_ROWS <<< "$STATS"
CURRENT_BRANCH="$(git branch --show-current)"
[[ "$CURRENT_BRANCH" == "main" ]] || fail "Must run on main (current branch: ${CURRENT_BRANCH:-detached})"
git diff --cached --quiet || fail "Refusing to run with pre-staged changes"

is_allowed_path() {
  [[ "$1" == "data/terapeak-meta.json" || "$1" =~ ^data/terapeak/[A-Za-z0-9][A-Za-z0-9._-]*\.csv$ ]]
}

validate_data_file() {
  is_allowed_path "$1" || fail "Unexpected Terapeak data path: $1"
  [[ ! -L "$1" && -f "$1" ]] || fail "Terapeak data path must be a regular file: $1"
}

UNUSUAL_UNTRACKED=()
while IFS= read -r -d '' path; do
  if ! is_allowed_path "$path"; then
    UNUSUAL_UNTRACKED+=("$path")
  fi
done < <(git ls-files --others --exclude-standard -z)

if (( ${#UNUSUAL_UNTRACKED[@]} > 0 )); then
  printf '[terapeak-progress:FAIL] Refusing unusual untracked file: %s\n' "${UNUSUAL_UNTRACKED[@]}" >&2
  exit 1
fi

CHANGED_FILES=()
declare -A SEEN=()
while IFS= read -r -d '' path; do
  validate_data_file "$path"
  if [[ -z "${SEEN[$path]+x}" ]]; then
    CHANGED_FILES+=("$path")
    SEEN["$path"]=1
  fi
done < <(git diff --name-only -z -- data/terapeak data/terapeak-meta.json)

while IFS= read -r -d '' path; do
  validate_data_file "$path"
  if [[ -z "${SEEN[$path]+x}" ]]; then
    CHANGED_FILES+=("$path")
    SEEN["$path"]=1
  fi
done < <(git ls-files --others --exclude-standard -z -- data/terapeak data/terapeak-meta.json)

if (( ${#CHANGED_FILES[@]} == 0 )); then
  echo "[terapeak-progress] No Terapeak CSV or meta changes; nothing to commit."
  exit 0
fi

BRANCH="data/terapeak-refresh-$RUN_ID"
COMMIT_SUBJECT="data: record Terapeak refresh $RUN_ID"
SUMMARY="passes=$PASS_COUNT attempted=$ATTEMPTED succeeded=$SUCCEEDED empty=$EMPTY failed=$FAILED new=$NEW_ROWS duplicates=$DUP_ROWS"
PR_TITLE="data: Terapeak refresh $RUN_ID"

echo "[terapeak-progress] run_id=$RUN_ID $SUMMARY"
echo "[terapeak-progress] branch=$BRANCH"
printf '[terapeak-progress] file=%s\n' "${CHANGED_FILES[@]}"

if $DRY_RUN; then
  echo "[terapeak-progress] DRY-RUN commit=$COMMIT_SUBJECT"
  echo "[terapeak-progress] DRY-RUN PR=$PR_TITLE"
  exit 0
fi

command -v "$GH_BIN" >/dev/null 2>&1 || fail "gh is required outside --dry-run"
ORIGIN_URL="$(git remote get-url origin)" || fail "origin remote is required"
mapfile -t PUSH_URLS < <(git remote get-url --push --all origin)
(( ${#PUSH_URLS[@]} == 1 )) || fail "origin must have exactly one push URL"
[[ "${PUSH_URLS[0]}" == "$ORIGIN_URL" ]] || fail "origin push URL must match its fetch URL"
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_MAIN_SHA="$(git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 { print $1 }')" || fail "Could not read origin/main"
[[ -n "$REMOTE_MAIN_SHA" && "$HEAD_SHA" == "$REMOTE_MAIN_SHA" ]] || fail "Local main must exactly match origin/main"

TARGET_REPO="$REPO_OVERRIDE"
if [[ -z "$TARGET_REPO" ]]; then
  case "$ORIGIN_URL" in
    https://github.com/*) TARGET_REPO="${ORIGIN_URL#https://github.com/}" ;;
    ssh://git@github.com/*) TARGET_REPO="${ORIGIN_URL#ssh://git@github.com/}" ;;
    git@github.com:*) TARGET_REPO="${ORIGIN_URL#git@github.com:}" ;;
    *) fail "Cannot derive GitHub repository from origin; pass --repo OWNER/REPO" ;;
  esac
  TARGET_REPO="${TARGET_REPO%.git}"
fi
[[ "$TARGET_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid GitHub repository: $TARGET_REPO"
if git show-ref --verify --quiet "refs/heads/$BRANCH" || git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  fail "Branch already exists: $BRANCH"
fi

git switch -c "$BRANCH"
git add -- "${CHANGED_FILES[@]}"
git diff --cached --quiet && fail "No staged Terapeak changes after path filtering"
git commit -m "$COMMIT_SUBJECT" -m "$SUMMARY"
git push -u origin "$BRANCH"

PR_BODY=$(cat <<EOF
## Terapeak refresh

- Run: \`$RUN_ID\`
- Passes: $PASS_COUNT
- Attempted: $ATTEMPTED
- Succeeded: $SUCCEEDED
- Empty: $EMPTY
- Failed: $FAILED
- New rows: $NEW_ROWS
- Duplicate rows: $DUP_ROWS

Generated by \`scripts/commit-terapeak-progress.sh\`. Merge remains manual.
EOF
)

PR_URL="$({ unset GITHUB_TOKEN GH_TOKEN GH_REPO GH_HOST GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; "$GH_BIN" pr create --repo "$TARGET_REPO" --base main --head "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY"; })"
echo "[terapeak-progress] PR=$PR_URL"
