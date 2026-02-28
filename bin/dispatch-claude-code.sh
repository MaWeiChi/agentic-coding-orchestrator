#!/bin/bash
# dispatch-claude-code.sh — Dispatch a task to Claude Code with auto-callback
#
# Usage:
#   dispatch-claude-code.sh [OPTIONS] -p "your prompt here"
#
# Options:
#   -p, --prompt TEXT        Task prompt (required, or use --from-orchestrator)
#   -n, --name NAME          Task name (for tracking)
#   -g, --group ID           Chat group ID for result delivery
#   -c, --channel CHANNEL    Notify channel: whatsapp, telegram, etc.
#   --notify-target TARGET   Notify target (phone/group ID)
#   -w, --workdir DIR        Working directory for Claude Code
#   --from-orchestrator ROOT Use orchestrator dispatch() to generate prompt
#   --permission-mode MODE   Claude Code permission mode
#   --allowed-tools TOOLS    Allowed tools string
#
# The script:
#   1. Writes task metadata to task-meta.json (hook reads this)
#   2. Runs Claude Code (prompt via -p)
#   3. When Claude Code finishes, Stop hook fires automatically
#   4. Hook reads meta + HANDOFF, writes results, notifies AGI

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults
PROMPT=""
TASK_NAME="adhoc-$(date +%s)"
GROUP=""
CHANNEL=""
NOTIFY_TARGET=""
WORKDIR="."
FROM_ORCHESTRATOR=""
PERMISSION_MODE=""
ALLOWED_TOOLS=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--prompt) PROMPT="$2"; shift 2;;
        -n|--name) TASK_NAME="$2"; shift 2;;
        -g|--group) GROUP="$2"; shift 2;;
        -c|--channel) CHANNEL="$2"; shift 2;;
        --notify-target) NOTIFY_TARGET="$2"; shift 2;;
        -w|--workdir) WORKDIR="$2"; shift 2;;
        --from-orchestrator) FROM_ORCHESTRATOR="$2"; shift 2;;
        --permission-mode) PERMISSION_MODE="$2"; shift 2;;
        --allowed-tools) ALLOWED_TOOLS="$2"; shift 2;;
        *) echo "Unknown option: $1" >&2; exit 1;;
    esac
done

# If --from-orchestrator, use CLI to get prompt + <task-meta>
if [ -n "$FROM_ORCHESTRATOR" ]; then
    WORKDIR="$FROM_ORCHESTRATOR"
    RAW_OUTPUT=$(orchestrator dispatch "$FROM_ORCHESTRATOR" 2>/dev/null)

    # If empty or "Already running", try apply-handoff to advance state, then retry
    if [ -z "$RAW_OUTPUT" ] || [[ "$RAW_OUTPUT" == *"Already running"* ]] || [[ "$RAW_OUTPUT" == *"DONE:"* ]]; then
        echo "First dispatch returned empty/stale, attempting state advance..." >&2
        orchestrator apply-handoff "$FROM_ORCHESTRATOR" 2>/dev/null || true
        sleep 1
        RAW_OUTPUT=$(orchestrator dispatch "$FROM_ORCHESTRATOR" 2>/dev/null)
    fi

    # Still empty after retry — genuinely done or needs human
    if [ -z "$RAW_OUTPUT" ] || [[ "$RAW_OUTPUT" == *"Already running"* ]] || [[ "$RAW_OUTPUT" == *"DONE:"* ]] || [[ "$RAW_OUTPUT" == *"NEEDS HUMAN"* ]]; then
        echo "Orchestrator returned no actionable prompt (story may be done or needs human)" >&2
        echo "Last output: ${RAW_OUTPUT:-<empty>}" >&2
        exit 0
    fi

    # ── Parse <task-meta> JSON block from orchestrator output ──
    TASK_META_JSON=""
    if [[ "$RAW_OUTPUT" == *"<task-meta>"* ]]; then
        TASK_META_JSON=$(echo "$RAW_OUTPUT" | sed -n '/<task-meta>/,/<\/task-meta>/p' | sed '/<\/*task-meta>/d')
        # Strip <task-meta> block from prompt (claude -p gets clean prompt only)
        PROMPT=$(echo "$RAW_OUTPUT" | sed '/<task-meta>/,/<\/task-meta>/d' | sed '/^$/N;/^\n$/d')
    else
        PROMPT="$RAW_OUTPUT"
    fi

    # Auto-generate task name: prefer <task-meta>, fallback to STATE query
    if [[ "$TASK_NAME" == adhoc-* ]]; then
        if [ -n "$TASK_META_JSON" ]; then
            TASK_NAME=$(echo "$TASK_META_JSON" | jq -r '.task_name // "unknown"')
            echo "Task name (from <task-meta>): ${TASK_NAME}" >&2
        else
            AUTO_STATE=$(orchestrator status "$FROM_ORCHESTRATOR" 2>/dev/null)
            AUTO_STORY=$(echo "$AUTO_STATE" | jq -r '.story // "unknown"')
            AUTO_STEP=$(echo "$AUTO_STATE" | jq -r '.step // "unknown"')
            TASK_NAME="${AUTO_STORY}-${AUTO_STEP}"
            echo "Task name (from STATE): ${TASK_NAME}" >&2
        fi
    fi
fi

if [ -z "$PROMPT" ]; then
    echo "Error: --prompt or --from-orchestrator is required" >&2
    exit 1
fi

# ---- 1. Write task metadata ----
ABS_WORKDIR="$(cd "$WORKDIR" && pwd)"

# Resolve RESULT_DIR — if already absolute, use as-is; otherwise resolve relative to WORKDIR.
_RD="${RESULT_DIR:-.ai/claude-code-results}"
if [[ "$_RD" == /* ]]; then
    RESULT_DIR="$_RD"
else
    RESULT_DIR="${ABS_WORKDIR}/${_RD}"
fi
META_FILE="${RESULT_DIR}/task-meta.json"
TASK_OUTPUT="${RESULT_DIR}/task-output.txt"

mkdir -p "$RESULT_DIR"

# [FIX P0] Inherit runtime fields (group, notify_channel, notify_target) from
# existing task-meta.json when not provided via CLI. Without this, subsequent
# dispatch-claude-code.sh invocations overwrite these fields with empty strings,
# causing the hook to skip WhatsApp/Telegram notifications for all steps after bdd.
if [ -f "$META_FILE" ]; then
    [ -z "$GROUP" ] && GROUP=$(jq -r '.group // ""' "$META_FILE" 2>/dev/null || echo "")
    [ -z "$CHANNEL" ] && CHANNEL=$(jq -r '.notify_channel // ""' "$META_FILE" 2>/dev/null || echo "")
    [ -z "$NOTIFY_TARGET" ] && NOTIFY_TARGET=$(jq -r '.notify_target // ""' "$META_FILE" 2>/dev/null || echo "")
fi

# Build task-meta.json — merge orchestrator <task-meta> fields when available
if [ -n "$TASK_META_JSON" ]; then
    # Start from orchestrator metadata, overlay runtime fields
    echo "$TASK_META_JSON" | jq \
        --arg tn "$TASK_NAME" \
        --arg grp "$GROUP" \
        --arg ch "$CHANNEL" \
        --arg nt "$NOTIFY_TARGET" \
        --arg wd "$ABS_WORKDIR" \
        --arg sa "$(date -Iseconds)" \
        '. + {task_name: $tn, group: $grp, notify_channel: $ch, notify_target: $nt, workdir: $wd, started_at: $sa, status: "running"}' \
        > "$META_FILE"
else
    cat > "$META_FILE" << METAEOF
{
  "task_name": "${TASK_NAME}",
  "group": "${GROUP}",
  "notify_channel": "${CHANNEL}",
  "notify_target": "${NOTIFY_TARGET}",
  "workdir": "${ABS_WORKDIR}",
  "started_at": "$(date -Iseconds)",
  "status": "running"
}
METAEOF
fi

echo "Dispatched task: ${TASK_NAME} in ${ABS_WORKDIR}" >&2

# ---- 2. Build claude CLI command ----
CLAUDE_CMD=(claude)

# Permission handling:
#   --dangerously-skip-permissions is a standalone flag (NOT a --permission-mode value)
#   Headless (-p) mode cannot prompt interactively, so default to skip permissions.
if [ -n "$PERMISSION_MODE" ]; then
    # Caller explicitly set a mode — respect it
    CLAUDE_CMD+=(--permission-mode "$PERMISSION_MODE")
else
    # Default for headless: skip all permission prompts
    CLAUDE_CMD+=(--dangerously-skip-permissions)
fi

if [ -n "$ALLOWED_TOOLS" ]; then
    IFS=',' read -ra TOOLS <<< "$ALLOWED_TOOLS"
    for tool in "${TOOLS[@]}"; do
        CLAUDE_CMD+=(--allowedTools "$tool")
    done
fi

# -p and prompt go last
CLAUDE_CMD+=(-p "$PROMPT")

# ---- 3. Run Claude Code ----
cd "$ABS_WORKDIR"
export RESULT_DIR

HANDOFF_FILE="${ABS_WORKDIR}/.ai/HANDOFF.md"

"${CLAUDE_CMD[@]}" 2>&1 | tee "$TASK_OUTPUT"
EXIT_CODE=${PIPESTATUS[0]}

# ---- 4. Update task metadata with result ----
if [ -f "$META_FILE" ]; then
    FINAL_STATUS="done"
    [ "$EXIT_CODE" -ne 0 ] && FINAL_STATUS="failed"
    jq --arg status "$FINAL_STATUS" \
       --arg completed "$(date -Iseconds)" \
       --arg exit_code "$EXIT_CODE" \
       '.status = $status | .completed_at = $completed | .exit_code = ($exit_code | tonumber)' \
       "$META_FILE" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "$META_FILE"
fi

# ---- 5. Ensure HANDOFF is applied after CC exits ----
if [ -n "$FROM_ORCHESTRATOR" ] && command -v orchestrator &>/dev/null; then
    # If CC exited without writing HANDOFF (crash/timeout), synthesize a failing one
    # so applyHandoff transitions state from "running" → "failing" instead of "pending".
    if [ ! -f "$HANDOFF_FILE" ] && [ "$EXIT_CODE" -ne 0 ]; then
        CURRENT_STEP=$(jq -r '.step // "unknown"' "${ABS_WORKDIR}/.ai/STATE.json" 2>/dev/null || echo "unknown")
        CURRENT_STORY=$(jq -r '.story // "unknown"' "${ABS_WORKDIR}/.ai/STATE.json" 2>/dev/null || echo "unknown")
        echo "CC exited ($EXIT_CODE) without HANDOFF — synthesizing failing HANDOFF" >&2
        cat > "$HANDOFF_FILE" << HANDOFF_EOF
---
story: ${CURRENT_STORY}
step: ${CURRENT_STEP}
status: failing
reason: "CC exited with code ${EXIT_CODE} without writing HANDOFF.md"
---
# HANDOFF — Executor Crash Recovery
CC session exited with code ${EXIT_CODE} without producing a HANDOFF.
This synthetic HANDOFF was generated by dispatch-claude-code.sh to unblock the pipeline.
HANDOFF_EOF
    fi
    orchestrator apply-handoff "$ABS_WORKDIR" 2>/dev/null || true
fi

exit "$EXIT_CODE"