#!/bin/bash
# ============================================================
# batch-gmail-import.sh
# Imports Gmail history into OB1 / JGB Brain (Supabase)
# Works backwards in 3-month chunks using --before= flag.
# SHA-256 dedup means it's safe to re-run anytime.
#
# Schedule daily at 8am via cron:
#   crontab -e
#   0 8 * * * /Users/grahambinks/Library/MobileDocuments/com~apple~CloudDocs/GrahamB/MyOpenBrain/batch-gmail-import.sh >> /Users/grahambinks/Library/MobileDocuments/com~apple~CloudDocs/GrahamB/MyOpenBrain/batch-import.log 2>&1
# ============================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────
SCRIPT_DIR="/Users/grahambinks/Library/MobileDocuments/com~apple~CloudDocs/GrahamB/MyOpenBrain"
GMAIL_SCRIPT="$SCRIPT_DIR/pull-gmail.ts"
CURSOR_FILE="$SCRIPT_DIR/.import-cursor"
LOG_FILE="$SCRIPT_DIR/batch-import.log"
BATCH_SIZE=500
CHUNK_MONTHS=3        # go back 3 months per batch
MAX_BATCHES=100       # safety cap — covers ~25 years of history
SLEEP_BETWEEN=10      # seconds between batches

# ── Email notifications ────────────────────────────────────
NOTIFY_TO="grahambinks@gmail.com"
NOTIFY_FROM="grahambinks@gmail.com"
GMAIL_APP_PASSWORD="qrhfizscsdgxzuap"    # ⚠️ Replace if rotated

# ── Logging ───────────────────────────────────────────────
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ── Send email via Gmail SMTP ──────────────────────────────
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

# ── Query Supabase for total record count ─────────────────
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

# ── Subtract months from date (macOS BSD date) ────────────
subtract_months() {
  local date="$1"
  local months="$2"
  date -j -v"-${months}m" -f '%Y-%m-%d' "$date" '+%Y-%m-%d'
}

# ── Read or initialise cursor ─────────────────────────────
if [[ -f "$CURSOR_FILE" ]]; then
  BEFORE_DATE=$(cat "$CURSOR_FILE")
  log "Resuming from cursor: $BEFORE_DATE"
else
  BEFORE_DATE=$(date '+%Y-%m-%d')
  log "No cursor — starting from today: $BEFORE_DATE"
fi

# ── Main loop ─────────────────────────────────────────────
log "═══════════════════════════════════════"
log "Starting Gmail import run — $(date '+%Y-%m-%d %H:%M:%S')"
log "Chunk: ${CHUNK_MONTHS} months | Batch size: $BATCH_SIZE | Max batches: $MAX_BATCHES"
log "═══════════════════════════════════════"

cd "$SCRIPT_DIR"

BATCH_NUM=0
TOTAL_INGESTED=0

while [[ $BATCH_NUM -lt $MAX_BATCHES ]]; do
  BATCH_NUM=$((BATCH_NUM + 1))

  log "Batch $BATCH_NUM: before $BEFORE_DATE"

  RESULT=$(deno run \
    --allow-net \
    --allow-read \
    --allow-write \
    --allow-env \
    "$GMAIL_SCRIPT" \
    --window=all \
    --before="$BEFORE_DATE" \
    --limit="$BATCH_SIZE" \
    --labels=SENT,INBOX \
    --include-to \
    2>&1) || true

  log "$RESULT"

  # ── Parse results ────────────────────────────────────────
  INGESTED=$(echo "$RESULT"        | grep -oE "Ingested:[[:space:]]+[0-9]+"        | grep -oE "[0-9]+" || echo "0")
  ALREADY=$(echo "$RESULT"         | grep -oE "Already ingested:[[:space:]]+[0-9]+" | grep -oE "[0-9]+" | head -1 || echo "0")
  FOUND=$(echo "$RESULT"           | grep -oE "Emails found:[[:space:]]+[0-9]+"    | grep -oE "[0-9]+" || echo "0")
  SKIPPED=$(echo "$RESULT"         | grep -oE "Skipped \(noise\):[[:space:]]+[0-9]+" | grep -oE "[0-9]+" || echo "0")
  ERRORS=$(echo "$RESULT"          | grep -oE "Errors:[[:space:]]+[0-9]+"          | grep -oE "[0-9]+" || echo "0")
  COST=$(echo "$RESULT"            | grep -oE "Est\. API cost:[[:space:]]+\\\$[0-9.]+" | grep -oE "\\\$[0-9.]+" || echo "unknown")
  SUPABASE_TOTAL=$(get_supabase_count)

  TOTAL_INGESTED=$((TOTAL_INGESTED + INGESTED))

  log "Batch $BATCH_NUM — Found: $FOUND | Already: $ALREADY | Ingested: $INGESTED | Skipped: $SKIPPED | Errors: $ERRORS | Supabase total: $SUPABASE_TOTAL"

  # ── Send batch email ─────────────────────────────────────
  send_email \
    "📬 JGB Brain — Batch $BATCH_NUM: $INGESTED new thoughts (before $BEFORE_DATE)" \
    "Batch $BATCH_NUM complete.

  Before date      : $BEFORE_DATE
  Emails found     : $FOUND
  Already ingested : $ALREADY (skipped)
  Ingested         : $INGESTED new thoughts
  Skipped (noise)  : $SKIPPED
  Errors           : $ERRORS
  Est. API cost    : $COST

  Run total        : $TOTAL_INGESTED thoughts this run
  Supabase total   : $SUPABASE_TOTAL thoughts in database"

  # ── Stop if nothing found ────────────────────────────────
  if [[ "$FOUND" == "0" ]] || [[ "$FOUND" == "" ]]; then
    log "No more emails found — history fully imported!"
    rm -f "$CURSOR_FILE"
    send_email \
      "✅ JGB Brain — Gmail import complete!" \
      "All done! No more emails to import.

  Total batches    : $BATCH_NUM
  Total this run   : $TOTAL_INGESTED thoughts
  Supabase total   : $SUPABASE_TOTAL thoughts in database

The cursor has been cleared. Daily runs will now just pick up new emails."
    break
  fi

  # ── Move cursor back by CHUNK_MONTHS ─────────────────────
  BEFORE_DATE=$(subtract_months "$BEFORE_DATE" "$CHUNK_MONTHS")
  echo "$BEFORE_DATE" > "$CURSOR_FILE"
  log "Cursor saved: $BEFORE_DATE — sleeping ${SLEEP_BETWEEN}s"
  sleep "$SLEEP_BETWEEN"

done

log "═══════════════════════════════════════"
log "Run complete — $BATCH_NUM batches, $TOTAL_INGESTED thoughts ingested"
log "═══════════════════════════════════════"
