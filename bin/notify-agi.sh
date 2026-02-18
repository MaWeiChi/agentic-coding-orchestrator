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

RESULT_DIR="${RESULT_DIR:-.ai/claude-code-results}"
META_FILE="${RESULT_DIR}/task-meta.json"
LOG="${RESULT_DIR}/hook.log"

mkdir -p "$RESULT_DIR"
log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

log "=== Hook fired ==="

# ---- Read stdin (Claude Code hook event) ----
INPUT=""
if [ -t 0 ]; then
    log "stdin is tty, skip"
elif [ -e /dev/stdin ]; then
    INPUT=$(timeout 2 cat /dev/stdin 2>/dev/null || true)
fi

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"' 2>/dev/null || echo "unknown")

log "session=$SESSION_ID cwd=$CWD event=$EVENT"

# ---- Dedup 1: session-ID lock (one send per CC session) ----
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "unknown" ]; then
    SESSION_LOCK="${RESULT_DIR}/.session-${SESSION_ID}.lock"
    if [ -f "$SESSION_LOCK" ]; then
        log "Already processed session $SESSION_ID, skip"
        exit 0
    fi
    touch "$SESSION_LOCK"
    # Clean up session locks older than 1 hour
    find "$RESULT_DIR" -name '.session-*.lock' -mmin +60 -delete 2>/dev/null || true
fi

# ---- Dedup 2: time-based lock (30s cooldown, macOS + Linux compatible) ----
LOCK_FILE="${RESULT_DIR}/.hook-lock"
if [ -f "$LOCK_FILE" ]; then
    # macOS: stat -f %m  |  Linux: stat -c %Y
    LOCK_TIME=$(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE=$(( NOW - LOCK_TIME ))
    if [ "$AGE" -lt 30 ]; then
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
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    CLI="${SCRIPT_DIR}/../agentic-coding-orchestrator/src/cli.ts"
    if [ -f "$CLI" ]; then
        npx ts-node "$CLI" apply-handoff "$CWD" >> "$LOG" 2>&1 && \
            log "Applied HANDOFF to STATE" || \
            log "HANDOFF apply failed"
    fi
fi

# ---- Notify: push message to user (if configured) ----
CHANNEL=$(jq -r '.notify_channel // ""' "$META_FILE" 2>/dev/null || echo "")
NOTIFY_TARGET=$(jq -r '.notify_target // ""' "$META_FILE" 2>/dev/null || echo "")
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

if [ -n "$CHANNEL" ] && [ -n "$NOTIFY_TARGET" ] && command -v "$OPENCLAW_BIN" &>/dev/null; then
    SUMMARY=$(echo "$OUTPUT" | tail -c 1000 | tr '\n' ' ')
    MSG="CC task done: ${TASK_NAME}
${SUMMARY:0:800}"

    "$OPENCLAW_BIN" message send \
        --channel "$CHANNEL" \
        --target "$NOTIFY_TARGET" \
        --message "$MSG" >> "$LOG" 2>&1 && \
        log "Sent $CHANNEL message to $NOTIFY_TARGET" || \
        log "$CHANNEL send failed"
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
log "=== Hook completed ==="
exit 0
