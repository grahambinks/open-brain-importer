#!/bin/bash
# ============================================================
# brain-import.sh
# Orchestrates gmail-to-openbrain.ts for full Gmail history import.
# Works backwards in 1-month chunks using --before= flag.
# No MAX_BATCHES cap — runs until done or manually stopped.
# Cursor persists across restarts.
#
# Usage:
#   ./brain-import.sh [options]
#
# Options:
#   --labels=SENT,INBOX         Gmail labels (default: SENT)
#   --include-to                Include To: field in content
#   --query=STRING              Extra Gmail query string
#   --notify=debug|hourly|cautious  Notification mode (default: cautious)
#
# Schedule daily at 8am:
#   crontab -e
#   0 8 * * * ~/MyOpenBrain/brain-import.sh --labels=SENT --include-to >> ~/MyOpenBrain/brain-import.log 2>&1
# ============================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GMAIL_SCRIPT="$SCRIPT_DIR/gmail-to-openbrain.ts"
CURSOR_FILE="$SCRIPT_DIR/.import-cursor"
LOG_FILE="$SCRIPT_DIR/brain-import.log"
BATCH_SIZE=500
CHUNK_MONTHS=1        # 1 month per batch — minimises >500 email windows
SLEEP_BETWEEN=10      # seconds between batches
EMPTY_WINDOW_LIMIT=3  # consecutive empty windows before declaring done

# ── Notification ──────────────────────────────────────────
NOTIFY_MODE="cautious"   # debug | hourly | cautious
NOTIFY_TO="grahambinks@gmail.com"
NOTIFY_FROM="grahambinks@gmail.com"
GMAIL_APP_PASSWORD="qrhfizscsdgxzuap"  # ⚠️ Replace if rotated

# ── Parse CLI args ────────────────────────────────────────
LABELS="SENT"
INCLUDE_TO=""
EXTRA_QUERY=""

for arg in "$@"; do
  case "$arg" in
    --labels=*)      LABELS="${arg#*=}" ;;
    --include-to)    INCLUDE_TO="--include-to" ;;
    --query=*)       EXTRA_QUERY="--query=${arg#*=}" ;;
    --notify=*)      NOTIFY_MODE="${arg#*=}" ;;
  esac
done

# ── Logging ───────────────────────────────────────────────
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ── Gmail SMTP notification ───────────────────────────────
send_email() {
  local subject="$1"
  local body="$2"
  local password="${GMAIL_APP_PASSWORD// /}"
  curl --silent --ssl-reqd \
    --url "smtps://smtp.gmail.com:465" \
    --user "${NOTIFY_FROM}:${password}" \
    --mail-from "$NOTIFY_FROM" \
    --mail-rcpt "$NOTIFY_TO" \
    --upload-file <(printf "From: %s\nTo: %s\nSubject: %s\n\n%s\n" \
      "$NOTIFY_FROM" "$NOTIFY_TO" "$subject" "$body") \
    2>&1 || log "Warning: email notification failed"
}

# ── Supabase record count ─────────────────────────────────
get_supabase_count() {
  curl --silent \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Prefer: count=exact" \
    -H "Range: 0-0" \
    -I "${SUPABASE_URL}/rest/v1/thoughts?select=id" 2>/dev/null \
    | grep -i "content-range" \
    | grep -oE "/[0-9]+" \
    | tr -d "/" || echo "unknown"
}

# ── Date arithmetic (macOS BSD date) ─────────────────────
subtract_months() {
  local date="$1"
  local months="$2"
  date -j -v"-${months}m" -f '%Y-%m-%d' "$date" '+%Y-%m-%d'
}

format_elapsed() {
  local seconds=$1
  printf "%02d:%02d" $((seconds / 60)) $((seconds % 60))
}

# ── Generate unique batch ID ──────────────────────────────
generate_batch_id() {
  local today
  today=$(date '+%Y-%m-%d')
  local base="${today}-run"
  local n=1
  # Check cursor file for existing run number today
  if [[ -f "$CURSOR_FILE.meta" ]]; then
    local stored_id
    stored_id=$(cat "$CURSOR_FILE.meta")
    if [[ "$stored_id" == ${today}-run* ]]; then
      # Same day — increment
      local current_n="${stored_id##*run}"
      n=$((current_n + 1))
    fi
  fi
  echo "${base}${n}"
}

# ── Read or initialise cursor ─────────────────────────────
if [[ -f "$CURSOR_FILE" ]]; then
  BEFORE_DATE=$(cat "$CURSOR_FILE")
  log "Resuming from cursor: $BEFORE_DATE"
else
  BEFORE_DATE=$(date '+%Y-%m-%d')
  log "No cursor — starting from today: $BEFORE_DATE"
fi

# ── Generate batch ID ─────────────────────────────────────
IMPORT_BATCH=$(generate_batch_id)
echo "$IMPORT_BATCH" > "$CURSOR_FILE.meta"
log "Import batch: $IMPORT_BATCH"

# ── Keep Mac awake ────────────────────────────────────────
caffeinate -i &
CAFFEINATE_PID=$!
trap "kill $CAFFEINATE_PID 2>/dev/null || true" EXIT

# ── Main loop ─────────────────────────────────────────────
log "═══════════════════════════════════════════════════════"
log "Starting brain-import — $(date '+%Y-%m-%d %H:%M:%S')"
log "Labels: $LABELS | Chunk: ${CHUNK_MONTHS}mo | Notify: $NOTIFY_MODE | Batch: $IMPORT_BATCH"
log "═══════════════════════════════════════════════════════"

cd "$SCRIPT_DIR"

BATCH_NUM=0
TOTAL_INGESTED=0
TOTAL_COST=0
EMPTY_WINDOWS=0
RUN_START=$(date +%s)
LAST_EMAIL_TIME=$RUN_START
NOTIFY_SWITCH_DONE=false  # for cautious mode

while true; do
  BATCH_NUM=$((BATCH_NUM + 1))
  BATCH_START=$(date +%s)

  log "Batch $BATCH_NUM: before $BEFORE_DATE"

  # Build deno command
  RESULT=$(deno run \
    --allow-net \
    --allow-read \
    --allow-write \
    --allow-env \
    "$GMAIL_SCRIPT" \
    --window=all \
    --before="$BEFORE_DATE" \
    --limit="$BATCH_SIZE" \
    --labels="$LABELS" \
    --import-batch="$IMPORT_BATCH" \
    $INCLUDE_TO \
    $EXTRA_QUERY \
    2>&1) || true

  log "$RESULT"

  # ── Parse results ─────────────────────────────────────
  INGESTED=$(echo "$RESULT"  | grep -oE "^[[:space:]]+Ingested[[:space:]]+:[[:space:]]+[0-9]+" | grep -oE "[0-9]+" || echo "0")
  ALREADY=$(echo "$RESULT"   | grep -oE "Already ingested[[:space:]]+:[[:space:]]+[0-9]+"       | grep -oE "[0-9]+" | head -1 || echo "0")
  FOUND=$(echo "$RESULT"     | grep -oE "Emails found[[:space:]]+:[[:space:]]+[0-9]+"           | grep -oE "[0-9]+" || echo "0")
  SKIPPED=$(echo "$RESULT"   | grep -oE "Skipped \(noise\)[[:space:]]+:[[:space:]]+[0-9]+"      | grep -oE "[0-9]+" || echo "0")
  ERRORS=$(echo "$RESULT"    | grep -oE "Errors[[:space:]]+:[[:space:]]+[0-9]+"                 | grep -oE "[0-9]+" || echo "0")
  COST=$(echo "$RESULT"      | grep -oE "Est\. API cost[[:space:]]+:[[:space:]]+\\\$[0-9.]+"    | grep -oE "[0-9.]+" || echo "0")

  TOTAL_INGESTED=$((TOTAL_INGESTED + INGESTED))
  TOTAL_COST=$(echo "$TOTAL_COST + $COST" | bc 2>/dev/null || echo "$TOTAL_COST")

  SUPABASE_TOTAL=$(get_supabase_count)
  ELAPSED=$(( $(date +%s) - RUN_START ))
  ELAPSED_FMT=$(format_elapsed $ELAPSED)

  log "Batch $BATCH_NUM — Found: $FOUND | Ingested: $INGESTED | Already: $ALREADY | Skipped: $SKIPPED | Errors: $ERRORS | Supabase: $SUPABASE_TOTAL"

  # ── Empty window tracking ─────────────────────────────
  if [[ "$FOUND" == "0" ]] || [[ -z "$FOUND" ]]; then
    EMPTY_WINDOWS=$((EMPTY_WINDOWS + 1))
    log "Empty window $EMPTY_WINDOWS / $EMPTY_WINDOW_LIMIT"

    if [[ $EMPTY_WINDOWS -ge $EMPTY_WINDOW_LIMIT ]]; then
      log "3 consecutive empty windows — import complete!"
      rm -f "$CURSOR_FILE" "$CURSOR_FILE.meta"
      send_email \
        "✅ Brain import complete! — $IMPORT_BATCH" \
        "All done! Gmail history fully imported.

  Import batch   : $IMPORT_BATCH
  Total batches  : $BATCH_NUM
  Total ingested : $TOTAL_INGESTED thoughts
  Supabase total : $SUPABASE_TOTAL thoughts
  Total cost     : \$$TOTAL_COST
  Elapsed        : $ELAPSED_FMT

Cursor cleared. Daily cron will pick up new emails."
      break
    fi
  else
    EMPTY_WINDOWS=0  # reset on any non-empty window
  fi

  # ── Notify logic ──────────────────────────────────────
  SHOULD_NOTIFY=false
  NOW=$(date +%s)

  case "$NOTIFY_MODE" in
    debug)
      SHOULD_NOTIFY=true
      ;;
    hourly)
      if (( NOW - LAST_EMAIL_TIME >= 3600 )); then
        SHOULD_NOTIFY=true
        LAST_EMAIL_TIME=$NOW
      fi
      ;;
    cautious)
      if [[ "$NOTIFY_SWITCH_DONE" == "false" ]]; then
        # First hour: debug mode
        if (( ELAPSED < 3600 )); then
          SHOULD_NOTIFY=true
        else
          NOTIFY_SWITCH_DONE=true
          log "Switching from debug to hourly notification mode"
        fi
      fi
      # After first hour: hourly
      if [[ "$NOTIFY_SWITCH_DONE" == "true" ]] && (( NOW - LAST_EMAIL_TIME >= 3600 )); then
        SHOULD_NOTIFY=true
        LAST_EMAIL_TIME=$NOW
      fi
      ;;
  esac

  if [[ "$SHOULD_NOTIFY" == "true" ]]; then
    send_email \
      "📬 Brain import — Batch $BATCH_NUM: $INGESTED new ($IMPORT_BATCH)" \
      "Batch $BATCH_NUM complete.

  Import batch    : $IMPORT_BATCH
  Before date     : $BEFORE_DATE
  Emails found    : $FOUND
  Already ingested: $ALREADY (skipped)
  Ingested        : $INGESTED new thoughts
  Skipped (noise) : $SKIPPED
  Errors          : $ERRORS
  Est. cost       : \$$COST

  Run total       : $TOTAL_INGESTED thoughts this run
  Supabase total  : $SUPABASE_TOTAL thoughts in database
  Elapsed         : $ELAPSED_FMT"
  fi

  # ── Advance cursor ────────────────────────────────────
  BEFORE_DATE=$(subtract_months "$BEFORE_DATE" "$CHUNK_MONTHS")
  echo "$BEFORE_DATE" > "$CURSOR_FILE"
  log "Cursor saved: $BEFORE_DATE — sleeping ${SLEEP_BETWEEN}s"
  sleep "$SLEEP_BETWEEN"

done

log "═══════════════════════════════════════════════════════"
log "Run complete — $BATCH_NUM batches | $TOTAL_INGESTED ingested | \$$TOTAL_COST | $ELAPSED_FMT"
log "═══════════════════════════════════════════════════════"
