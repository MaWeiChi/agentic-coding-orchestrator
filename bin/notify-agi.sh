#!/bin/bash
# notify-agi.sh — Claude Code Stop Hook: task complete callback
#
# Triggered by Claude Code on Stop + SessionEnd events.
# Reads task metadata, collects output, writes result, notifies AGI.
#
# Register in ~/.claude/settings.json:
#   "hooks": {
#     "Stop": [{"hooks": [{"type": "command", "command": "path/to/notify-agi.sh", "timeout": 10}]}],
#     "SessionEnd": [{"hooks": [{"type": "command", "command": "path/to/notify-agi.sh", "timeout": 10}]}]
#   }

set -uo pipefail

# ---- Read stdin (Claude Code hook event) FIRST to get CWD ----
INPUT=""
if [ -t 0 ]; then
    true  # stdin is tty, skip
else
    # macOS may lack coreutils timeout; use fallback chain
    if command -v timeout &>/dev/null; then
        INPUT=$(timeout 2 cat 2>/dev/null || true)
    else
        INPUT=$(cat 2>/dev/null &
            CAT_PID=$!
            sleep 2 && kill "$CAT_PID" 2>/dev/null &
            wait "$CAT_PID" 2>/dev/null || true)
        if [ -z "$INPUT" ]; then
            while IFS= read -r -t 2 line; do
                INPUT="${INPUT}${line}"
            done
        fi
    fi
fi

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"' 2>/dev/null || echo "unknown")

# Resolve PROJECT_ROOT: walk up from CWD to find .ai/STATE.json (the real project root).
# This handles cases where CC's CWD is a subdirectory (e.g., web/) that may also
# have a stale .ai/ directory from previous hook runs.
PROJECT_ROOT="$CWD"
if [ -n "$CWD" ]; then
    _search="$CWD"
    while [ "$_search" != "/" ] && [ -n "$_search" ]; do
        if [ -f "${_search}/.ai/STATE.json" ] || [ -f "${_search}/.ai/HANDOFF.md" ]; then
            PROJECT_ROOT="$_search"
            break
        fi
        _search=$(dirname "$_search")
    done
fi

# Resolve RESULT_DIR — if already absolute (from dispatch env), use as-is;
# otherwise resolve relative to PROJECT_ROOT.
_RD="${RESULT_DIR:-.ai/claude-code-results}"
if [[ "$_RD" == /* ]]; then
    RESULT_DIR="$_RD"
elif [ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ]; then
    RESULT_DIR="${PROJECT_ROOT}/${_RD}"
else
    RESULT_DIR="$_RD"
fi
META_FILE="${RESULT_DIR}/task-meta.json"
LOG="${RESULT_DIR}/hook.log"

mkdir -p "$RESULT_DIR"
log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

log "=== Hook fired ==="
log "session=$SESSION_ID cwd=$CWD event=$EVENT"
log "PROJECT_ROOT=$PROJECT_ROOT"

# ---- Dedup 1: session-ID lock (one send per CC session) ----
# Uses a GLOBAL lock dir (under /tmp) so Stop + SessionEnd share the same lock
# even if RESULT_DIR differs between events.
GLOBAL_LOCK_DIR="/tmp/orchestrator-hook-locks"
mkdir -p "$GLOBAL_LOCK_DIR"

SESSION_LOCK=""
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "unknown" ]; then
    SESSION_LOCK="${GLOBAL_LOCK_DIR}/.session-${SESSION_ID}.lock"
    if [ -f "$SESSION_LOCK" ]; then
        log "Already processed session $SESSION_ID, skip"
        exit 0
    fi
    # Don't touch lock yet — only lock after successful completion
    # Clean up session locks older than 1 hour
    find "$GLOBAL_LOCK_DIR" -name '.session-*.lock' -mmin +60 -delete 2>/dev/null || true
fi

# ---- Dedup 2: time-based lock (5s cooldown — Stop and SessionEnd fire within ~1s) ----
LOCK_FILE="${GLOBAL_LOCK_DIR}/.hook-lock"
if [ -f "$LOCK_FILE" ]; then
    # macOS: stat -f %m  |  Linux: stat -c %Y
    LOCK_TIME=$(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE=$(( NOW - LOCK_TIME ))
    if [ "$AGE" -lt 5 ]; then
        log "Duplicate within ${AGE}s, skip"
        exit 0
    fi
fi
touch "$LOCK_FILE"

# ---- Collect output ----
OUTPUT=""
# Note: removed `sleep 1` — it wasted 1 second of the 10-second hook timeout.

TASK_OUTPUT="${RESULT_DIR}/task-output.txt"
if [ -f "$TASK_OUTPUT" ] && [ -s "$TASK_OUTPUT" ]; then
    OUTPUT=$(tail -c 4000 "$TASK_OUTPUT")
    log "Output from task-output.txt (${#OUTPUT} chars)"
fi

if [ -z "$OUTPUT" ] && [ -f "/tmp/claude-code-output.txt" ] && [ -s "/tmp/claude-code-output.txt" ]; then
    OUTPUT=$(tail -c 4000 /tmp/claude-code-output.txt)
    log "Output from /tmp fallback"
fi

# ---- Read task metadata ----
TASK_NAME="unknown"
GROUP=""
CHANNEL=$(jq -r '.notify_channel // ""' "$META_FILE" 2>/dev/null || echo "")
NOTIFY_TARGET=$(jq -r '.notify_target // ""' "$META_FILE" 2>/dev/null || echo "")
if [ -f "$META_FILE" ]; then
    TASK_NAME=$(jq -r '.task_name // "unknown"' "$META_FILE" 2>/dev/null || echo "unknown")
    GROUP=$(jq -r '.group // ""' "$META_FILE" 2>/dev/null || echo "")
    log "Meta: task=$TASK_NAME group=$GROUP"
    log "Notify: channel=$CHANNEL target=$NOTIFY_TARGET openclaw=$(command -v ${OPENCLAW_BIN:-openclaw} 2>/dev/null || echo NOT_FOUND)"
fi

# ---- Write result JSON ----
jq -n \
    --arg sid "$SESSION_ID" \
    --arg ts "$(date -Iseconds)" \
    --arg cwd "$CWD" \
    --arg event "$EVENT" \
    --arg output "$OUTPUT" \
    --arg task "$TASK_NAME" \
    --arg group "$GROUP" \
    '{session_id: $sid, timestamp: $ts, cwd: $cwd, event: $event, output: $output, task_name: $task, group: $group, status: "done"}' \
    > "${RESULT_DIR}/latest.json" 2>/dev/null

log "Wrote latest.json"

# ---- Apply HANDOFF (if orchestrator project) ----
if [ -n "$CWD" ] && [ -f "$CWD/.ai/STATE.json" ] && [ -f "$CWD/.ai/HANDOFF.md" ]; then
    if command -v orchestrator &>/dev/null; then
        orchestrator apply-handoff "$CWD" >> "$LOG" 2>&1 && \
            log "Applied HANDOFF to STATE" || \
            log "HANDOFF apply failed"
    else
        # Fallback: try local CLI via npx
        SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
        CLI="${SCRIPT_DIR}/../agentic-coding-orchestrator/src/cli.ts"
        if [ -f "$CLI" ]; then
            npx ts-node "$CLI" apply-handoff "$CWD" >> "$LOG" 2>&1 && \
                log "Applied HANDOFF to STATE (via npx)" || \
                log "HANDOFF apply failed (via npx)"
        else
            log "No orchestrator CLI found, skip HANDOFF apply"
        fi
    fi
fi

# ---- Build plain-text notification message ----
SENT=false
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

build_notify_msg() {
    local handoff_file="${PROJECT_ROOT}/.ai/HANDOFF.md"
    local state_file="${PROJECT_ROOT}/.ai/STATE.json"

    # ---- Header ----
    local status_icon="✅"
    local h_status="" h_step="" h_story="" h_reason="" h_files="" h_body=""

    # Try reading from HANDOFF.md YAML frontmatter
    log "build_notify_msg: handoff=$handoff_file exists=$([ -f "$handoff_file" ] && echo Y || echo N)"
    if [ -f "$handoff_file" ]; then
        h_status=$(sed -n 's/^status: *//p' "$handoff_file" | head -1)
        log "build_notify_msg: h_status=$h_status"
        h_step=$(sed -n 's/^step: *//p' "$handoff_file" | head -1)
        h_story=$(sed -n 's/^story: *//p' "$handoff_file" | head -1)
        h_reason=$(sed -n 's/^reason: *//p' "$handoff_file" | head -1)
        h_files=$(sed -n 's/^files_changed: *\[*//p' "$handoff_file" | head -1 | tr -d '[]"')
        # Body: everything after second ---
        h_body=$(awk '/^---$/{n++; next} n>=2' "$handoff_file" | head -10 | sed -E \
            -e 's/\*\*([^*]+)\*\*/\1/g' \
            -e 's/`([^`]+)`/\1/g' \
            -e 's/^#{1,6} //' \
            -e '/^[[:space:]]*$/d')
    fi

    # Fallback to STATE.json
    if [ -z "$h_step" ] && [ -f "$state_file" ]; then
        h_step=$(jq -r '.step // ""' "$state_file" 2>/dev/null)
        h_story=$(jq -r '.story // ""' "$state_file" 2>/dev/null)
        h_status=$(jq -r '.status // ""' "$state_file" 2>/dev/null)
    fi

    [ "$h_status" = "failing" ] || [ "$h_status" = "needs_human" ] && status_icon="⚠️"

    # ---- Compose message ----
    echo "${status_icon} ${TASK_NAME} done"
    [ -n "$h_story" ] && echo "Story: ${h_story}"
    [ -n "$h_step" ] && echo "Step: ${h_step}"
    echo "Status: ${h_status:-unknown}"
    [ -n "$h_reason" ] && [ "$h_reason" != "null" ] && echo "Reason: ${h_reason}"
    [ -n "$h_files" ] && echo "Files: ${h_files}"
    if [ -n "$h_body" ]; then
        echo ""
        echo "$h_body" | head -c 400
    fi
}

# ---- Notification marker (dedup between Stop ↔ SessionEnd for sends only) ----
# Session lock dedupes the ENTIRE hook (apply-handoff, write json, etc.).
# Notify marker dedupes only the notification send — so SessionEnd can retry
# if Stop's background send failed, without being blocked by session lock.
NOTIFY_MARKER=""
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "unknown" ]; then
    NOTIFY_MARKER="${GLOBAL_LOCK_DIR}/.notify-${SESSION_ID}.sent"
    # Clean up old markers (same TTL as session locks)
    find "$GLOBAL_LOCK_DIR" -name '.notify-*.sent' -mmin +60 -delete 2>/dev/null || true
    find "$GLOBAL_LOCK_DIR" -name '.notify-*.lock' -mmin +60 -type d -exec rmdir {} \; 2>/dev/null || true
fi

# ---- Resolve timeout command (macOS may only have gtimeout from coreutils) ----
_TIMEOUT_CMD=""
if command -v timeout &>/dev/null; then
    _TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
    _TIMEOUT_CMD="gtimeout"
fi

if [ -n "$CHANNEL" ] && [ -n "$NOTIFY_TARGET" ] && command -v "$OPENCLAW_BIN" &>/dev/null; then
    # Already sent by a previous event (Stop bg succeeded before SessionEnd)?
    if [ -n "$NOTIFY_MARKER" ] && [ -f "$NOTIFY_MARKER" ]; then
        log "NOTIFY_RESULT: SKIPPED (already sent for session $SESSION_ID)"
        SENT=true
    else
        MSG=$(build_notify_msg)
        log "Sending $CHANNEL notification in background (msg_len=${#MSG})..."

        # [FIX P0] Run openclaw in a detached background process.
        # Root cause: Claude Code hook timeout is 10 seconds. The hook spends
        # ~3-4s on apply-handoff, and openclaw needs ~5-7s for the WhatsApp API call.
        # Total 8-11s often exceeds the 10s limit → hook killed → no notification.
        #
        # Design:
        #   - Background subshell sends notification asynchronously
        #   - Uses mkdir as atomic send lock (prevents concurrent Stop+SessionEnd sends)
        #   - On success: writes notify marker + session lock
        #   - On failure: no marker → SessionEnd can retry
        #   - Main process does NOT lock session → SessionEnd re-runs full hook
        #     (apply-handoff is idempotent, so this is safe)
        #   - EXIT trap guarantees a NOTIFY_RESULT line in hook.log no matter what
        #   - Timeout on openclaw prevents infinite hang
        (
            # ---- Guaranteed result logging ----
            # No matter how this subshell exits (success, failure, signal, crash),
            # the EXIT trap ensures a NOTIFY_RESULT line is written to hook.log.
            _NOTIFY_OUTCOME="UNKNOWN (subshell exited without setting result)"
            trap '
                echo "[$(date -Iseconds)] NOTIFY_RESULT: $_NOTIFY_OUTCOME" >> "$LOG"
                rmdir "$SEND_LOCK" 2>/dev/null
            ' EXIT

            # Acquire send lock (atomic via mkdir) to prevent concurrent sends
            SEND_LOCK="${GLOBAL_LOCK_DIR}/.notify-${SESSION_ID}.lock"
            if ! mkdir "$SEND_LOCK" 2>/dev/null; then
                _NOTIFY_OUTCOME="SKIPPED (another send in progress)"
                exit 0
            fi

            # Double-check marker after acquiring lock
            if [ -n "${NOTIFY_MARKER:-}" ] && [ -f "$NOTIFY_MARKER" ]; then
                _NOTIFY_OUTCOME="SKIPPED (already sent, checked after lock)"
                exit 0
            fi

            MAX_RETRIES=3
            RETRY_DELAY=3
            _SENT=false

            for i in $(seq 1 "$MAX_RETRIES"); do
                # Use timeout (30s) to prevent openclaw from hanging forever.
                # Background process is detached from hook timeout, so we can be generous.
                # openclaw cold-starts or API latency can easily exceed 15s.
                if [ -n "$_TIMEOUT_CMD" ]; then
                    _SEND_CMD="$_TIMEOUT_CMD 30 $OPENCLAW_BIN"
                else
                    _SEND_CMD="$OPENCLAW_BIN"
                fi

                _T_START=$(date +%s)
                if $_SEND_CMD message send \
                    --channel "$CHANNEL" \
                    --target "$NOTIFY_TARGET" \
                    --message "$MSG" >> "$LOG" 2>&1; then
                    _T_ELAPSED=$(( $(date +%s) - _T_START ))
                    _SENT=true
                    echo "[$(date -Iseconds)] $CHANNEL send OK in ${_T_ELAPSED}s (attempt $i/$MAX_RETRIES)" >> "$LOG"
                    break
                else
                    _EXIT_CODE=$?
                    _T_ELAPSED=$(( $(date +%s) - _T_START ))
                    if [ "$_EXIT_CODE" -eq 124 ]; then
                        echo "[$(date -Iseconds)] $CHANNEL send timed out after ${_T_ELAPSED}s (attempt $i/$MAX_RETRIES)" >> "$LOG"
                    else
                        echo "[$(date -Iseconds)] $CHANNEL send failed exit=$_EXIT_CODE after ${_T_ELAPSED}s (attempt $i/$MAX_RETRIES)" >> "$LOG"
                    fi
                    [ "$i" -lt "$MAX_RETRIES" ] && sleep "$RETRY_DELAY"
                fi
            done

            if [ "$_SENT" = true ]; then
                # Mark notification as sent (dedup for SessionEnd)
                [ -n "${NOTIFY_MARKER:-}" ] && touch "$NOTIFY_MARKER"
                # Lock session (dedup for full hook re-run)
                [ -n "${SESSION_LOCK:-}" ] && touch "$SESSION_LOCK"
                _NOTIFY_OUTCOME="SUCCESS — $CHANNEL to $NOTIFY_TARGET (attempt $i)"
            else
                _NOTIFY_OUTCOME="FAILED after $MAX_RETRIES attempts — SessionEnd will retry"
            fi
        ) &
        disown
    fi
else
    # Log why notification was skipped
    if [ -z "$CHANNEL" ] || [ -z "$NOTIFY_TARGET" ]; then
        log "NOTIFY_RESULT: SKIPPED (channel='$CHANNEL' target='$NOTIFY_TARGET' — missing config)"
    elif ! command -v "$OPENCLAW_BIN" &>/dev/null; then
        log "NOTIFY_RESULT: SKIPPED ($OPENCLAW_BIN not found)"
    fi
fi

# ---- Write pending-wake (fallback for AGI polling) ----
jq -n \
    --arg task "$TASK_NAME" \
    --arg group "$GROUP" \
    --arg ts "$(date -Iseconds)" \
    --arg summary "$(echo "$OUTPUT" | head -c 500 | tr '\n' ' ')" \
    '{task_name: $task, group: $group, timestamp: $ts, summary: $summary, processed: false}' \
    > "${RESULT_DIR}/pending-wake.json" 2>/dev/null

log "Wrote pending-wake.json"

# ---- Finalize session lock ----
# When notification is required: do NOT lock session here.
# The background send process will lock on success.
# This ensures SessionEnd can retry the full hook if the send failed.
NOTIFY_REQUIRED=false
[ -n "$CHANNEL" ] && [ -n "$NOTIFY_TARGET" ] && NOTIFY_REQUIRED=true

if [ -n "$SESSION_LOCK" ]; then
    if [ "$NOTIFY_REQUIRED" = false ]; then
        touch "$SESSION_LOCK"
        log "Session $SESSION_ID locked (done, no notification needed)"
    elif [ "$SENT" = true ]; then
        # Notification was already confirmed sent (marker found) — lock immediately
        touch "$SESSION_LOCK"
        log "Session $SESSION_ID locked (notification already confirmed)"
    else
        # Notification is in flight (background send) — don't lock yet.
        # Background will lock on success; if it fails, SessionEnd retries.
        log "Session $SESSION_ID: lock deferred to background send"
    fi
fi

log "=== Hook completed ==="
exit 0