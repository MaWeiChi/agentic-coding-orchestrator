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

# Resolve RESULT_DIR — if already absolute (from dispatch env), use as-is;
# otherwise resolve relative to CWD (project root).
_RD="${RESULT_DIR:-.ai/claude-code-results}"
if [[ "$_RD" == /* ]]; then
    RESULT_DIR="$_RD"
elif [ -n "$CWD" ] && [ -d "$CWD" ]; then
    RESULT_DIR="${CWD}/${_RD}"
else
    RESULT_DIR="$_RD"
fi
META_FILE="${RESULT_DIR}/task-meta.json"
LOG="${RESULT_DIR}/hook.log"

mkdir -p "$RESULT_DIR"
log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

log "=== Hook fired ==="
log "session=$SESSION_ID cwd=$CWD event=$EVENT"

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
sleep 1  # wait for tee flush

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

if [ -f "$META_FILE" ]; then
    TASK_NAME=$(jq -r '.task_name // "unknown"' "$META_FILE" 2>/dev/null || echo "unknown")
    GROUP=$(jq -r '.group // ""' "$META_FILE" 2>/dev/null || echo "")
    log "Meta: task=$TASK_NAME group=$GROUP"
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
CHANNEL=$(jq -r '.notify_channel // ""' "$META_FILE" 2>/dev/null || echo "")
NOTIFY_TARGET=$(jq -r '.notify_target // ""' "$META_FILE" 2>/dev/null || echo "")
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

build_notify_msg() {
    local handoff_file="${CWD}/.ai/HANDOFF.md"
    local state_file="${CWD}/.ai/STATE.json"

    # ---- Header ----
    local status_icon="✅"
    local h_status="" h_step="" h_story="" h_reason="" h_files="" h_body=""

    # Try reading from HANDOFF.md YAML frontmatter
    if [ -f "$handoff_file" ]; then
        h_status=$(sed -n 's/^status: *//p' "$handoff_file" | head -1)
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

if [ -n "$CHANNEL" ] && [ -n "$NOTIFY_TARGET" ] && command -v "$OPENCLAW_BIN" &>/dev/null; then
    MSG=$(build_notify_msg)
    MAX_RETRIES=3
    RETRY_DELAY=2
    SENT=false

    for i in $(seq 1 "$MAX_RETRIES"); do
        if "$OPENCLAW_BIN" message send \
            --channel "$CHANNEL" \
            --target "$NOTIFY_TARGET" \
            --message "$MSG" >> "$LOG" 2>&1; then
            log "Sent $CHANNEL message to $NOTIFY_TARGET (attempt $i)"
            SENT=true
            break
        else
            log "$CHANNEL send failed (attempt $i/$MAX_RETRIES)"
            [ "$i" -lt "$MAX_RETRIES" ] && sleep "$RETRY_DELAY"
        fi
    done

    [ "$SENT" = false ] && log "$CHANNEL send failed after $MAX_RETRIES attempts"
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
# Only lock the session if notification succeeded (or no notification configured).
# If notification failed, leave unlocked so next event can retry.
NOTIFY_REQUIRED=false
[ -n "$CHANNEL" ] && [ -n "$NOTIFY_TARGET" ] && NOTIFY_REQUIRED=true

if [ -n "$SESSION_LOCK" ]; then
    if [ "$NOTIFY_REQUIRED" = false ] || [ "$SENT" = true ]; then
        touch "$SESSION_LOCK"
        log "Session $SESSION_ID locked (done)"
    else
        log "Session $SESSION_ID NOT locked (notify failed, will retry)"
    fi
fi

log "=== Hook completed ==="
exit 0