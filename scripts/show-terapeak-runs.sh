#!/usr/bin/env bash
# Pretty-print the terapeak operator's structured run history.
#
# Reads:
#   cache/terapeak-runs/passes.jsonl   (one record per pass)
#   cache/terapeak-runs/coins.jsonl    (one record per coin attempt)
#
# Subcommands:
#   recent [N]               Last N passes across all runs (default 20)
#   runs   [N]               Last N runs aggregated (default 20)
#   run    <run_id>          Pass-by-pass breakdown for one run
#   coin   <pattern>         Per-coin history filtered by coin name regex
#   totals                   Lifetime totals across the whole ledger
#   stop-conditions          Last 5 runs and whether each ended cleanly
#   help                     Show this help
#
# Optional flags:
#   --since YYYY-MM-DD       Filter records to ts >= this date
#   --until YYYY-MM-DD       Filter records to ts <  this date
#   --json                   Emit raw JSON (no table formatting)
#
# Dependencies: jq, column. Both standard in this devcontainer.

set -u
set -o pipefail

cd "$(dirname "$0")/.."

PASSES="cache/terapeak-runs/passes.jsonl"
COINS="cache/terapeak-runs/coins.jsonl"

SINCE=""
UNTIL=""
RAW_JSON=false

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- arg parsing ------------------------------------------------------------
SUB=""
SUB_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --json)  RAW_JSON=true; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *)
      if [[ -z "$SUB" ]]; then
        SUB="$1"; shift
      elif [[ -z "$SUB_ARG" ]]; then
        SUB_ARG="$1"; shift
      else
        echo "[show-runs] unexpected arg: $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$SUB" ]]; then
  SUB="recent"
fi

if [[ ! -f "$PASSES" ]]; then
  echo "[show-runs] no run history yet -- $PASSES does not exist"
  echo "[show-runs] runs are recorded by scripts/terapeak-operator-codespace.sh"
  exit 0
fi

# ---- jq date filter helper --------------------------------------------------
jq_filter() {
  # Builds a jq filter that respects --since / --until on the .ts field.
  local extra="${1:-true}"
  local f="."
  if [[ -n "$SINCE" ]]; then
    f="$f | select(.ts >= \"${SINCE}T00:00:00Z\")"
  fi
  if [[ -n "$UNTIL" ]]; then
    f="$f | select(.ts < \"${UNTIL}T00:00:00Z\")"
  fi
  if [[ "$extra" != "true" ]]; then
    f="$f | select($extra)"
  fi
  printf '%s' "$f"
}

emit_table() {
  if [[ "$RAW_JSON" == "true" ]]; then
    cat
  else
    column -t -s $'\t'
  fi
}

# ---- subcommands ------------------------------------------------------------
sub_recent() {
  local n="${SUB_ARG:-20}"
  local filt; filt="$(jq_filter)"
  {
    printf "run_id\tpass\tts\tbatch\tok\tempty\tfail\tnew\tdups\tdur_s\n"
    jq -r "$filt | [.run_id, (.pass|tostring), .ts, (.batch_size|tostring), (.succeeded|tostring), (.empty|tostring), (.failed|tostring), (.new_rows|tostring), (.dup_rows|tostring), (.duration_sec // 0 | tostring)] | @tsv" "$PASSES" \
      | tail -n "$n"
  } | emit_table
}

sub_runs() {
  local n="${SUB_ARG:-20}"
  local filt; filt="$(jq_filter)"
  {
    printf "run_id\tmachine\tpasses\tok\tempty\tfail\tnew\tdups\tstart\tend\n"
    jq -sr "[ .[] | $filt ]
      | group_by(.run_id)
      | map({
          run_id: .[0].run_id,
          machine: .[0].machine,
          passes: length,
          ok:    (map(.succeeded) | add),
          empty: (map(.empty)     | add),
          fail:  (map(.failed)    | add),
          new:   (map(.new_rows)  | add),
          dups:  (map(.dup_rows)  | add),
          start: (map(.start_ts) | min),
          end:   (map(.end_ts)   | max)
        })
      | sort_by(.end) | reverse | .[0:${n}] | .[]
      | [.run_id, .machine, (.passes|tostring), (.ok|tostring), (.empty|tostring), (.fail|tostring), (.new|tostring), (.dups|tostring), .start, .end]
      | @tsv" "$PASSES"
  } | emit_table
}

sub_run() {
  if [[ -z "$SUB_ARG" ]]; then
    echo "[show-runs] usage: run <run_id>" >&2
    exit 2
  fi
  local rid="$SUB_ARG"
  {
    printf "pass\tbatch\tok\tempty\tfail\tunknown\tdormant\tnew\tdups\tdur_s\tstart\n"
    jq -r --arg rid "$rid" 'select(.run_id == $rid)
      | [(.pass|tostring), (.batch_size|tostring), (.succeeded|tostring), (.empty|tostring), (.failed|tostring), (.unknown|tostring), (.dormant|tostring), (.new_rows|tostring), (.dup_rows|tostring), (.duration_sec // 0 | tostring), .start_ts]
      | @tsv' "$PASSES"
  } | emit_table
}

sub_coin() {
  if [[ -z "$SUB_ARG" ]]; then
    echo "[show-runs] usage: coin <regex>" >&2
    exit 2
  fi
  if [[ ! -f "$COINS" ]]; then
    echo "[show-runs] $COINS does not exist yet"
    exit 0
  fi
  local pat="$SUB_ARG"
  {
    printf "ts\trun_id\tpass\tcoin\tstatus\tnew\tdups\tdormant\n"
    jq -r --arg pat "$pat" 'select(.coin | test($pat; "i"))
      | [.ts, .run_id, (.pass|tostring), .coin, .status, (.new|tostring), (.dups|tostring), (.dormant|tostring)]
      | @tsv' "$COINS"
  } | emit_table
}

sub_totals() {
  jq -s '. as $all
    | {
        passes: ($all | length),
        runs:   ($all | map(.run_id) | unique | length),
        attempted:  ($all | map(.attempted) | add),
        succeeded:  ($all | map(.succeeded) | add),
        empty:      ($all | map(.empty)     | add),
        failed:     ($all | map(.failed)    | add),
        new_rows:   ($all | map(.new_rows)  | add),
        dup_rows:   ($all | map(.dup_rows)  | add),
        first_seen: ($all | map(.start_ts)  | min),
        last_seen:  ($all | map(.end_ts)    | max)
      }' "$PASSES"
}

sub_stop_conditions() {
  # Look at the operator master logs for stop reasons; correlate with last passes
  local n="${SUB_ARG:-5}"
  {
    printf "run_id\tlast_pass\tfinal_status\tnew_total\tdup_total\n"
    jq -sr "[.[]] | group_by(.run_id)
      | map({
          run_id: .[0].run_id,
          last_pass: (map(.pass) | max),
          final_succeeded: (map(.succeeded) | add),
          final_new: (map(.new_rows) | add),
          final_dups: (map(.dup_rows) | add),
          last_end: (map(.end_ts) | max)
        })
      | sort_by(.last_end) | reverse | .[0:${n}] | .[]
      | [.run_id, (.last_pass|tostring), (.final_succeeded|tostring), (.final_new|tostring), (.final_dups|tostring)]
      | @tsv" "$PASSES"
  } | emit_table
}

case "$SUB" in
  recent)          sub_recent ;;
  runs)            sub_runs ;;
  run)             sub_run ;;
  coin)            sub_coin ;;
  totals)          sub_totals ;;
  stop-conditions) sub_stop_conditions ;;
  *)
    echo "[show-runs] unknown subcommand: $SUB" >&2
    usage >&2
    exit 2
    ;;
esac
