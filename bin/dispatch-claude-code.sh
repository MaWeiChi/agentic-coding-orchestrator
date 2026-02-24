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

# If --from-orchestrator, use CLI to get prompt
if [ -n "$FROM_ORCHESTRATOR" ]; then
    WORKDIR="$FROM_ORCHESTRATOR"
    PROMPT=$(orchestrator dispatch "$FROM_ORCHESTRATOR" 2>/dev/null)

    # If empty or "Already running", try apply-handoff to advance state, then retry
    if [ -z "$PROMPT" ] || [[ "$PROMPT" == *"Already running"* ]] || [[ "$PROMPT" == *"DONE:"* ]]; then
        echo "First dispatch returned empty/stale, attempting state advance..." >&2
        orchestrator apply-handoff "$FROM_ORCHESTRATOR" 2>/dev/null || true
        sleep 1
        PROMPT=$(orchestrator dispatch "$FROM_ORCHESTRATOR" 2>/dev/null)
    fi

    # Still empty after retry — genuinely done or needs human
    if [ -z "$PROMPT" ] || [[ "$PROMPT" == *"Already running"* ]] || [[ "$PROMPT" == *"DONE:"* ]] || [[ "$PROMPT" == *"NEEDS HUMAN"* ]]; then
        echo "Orchestrator returned no actionable prompt (story may be done or needs human)" >&2
        echo "Last output: ${PROMPT:-<empty>}" >&2
        exit 0
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

# ---- 5. Ensure HANDOFF is applied before hook fires ----
# Prevents race: Claude writes HANDOFF → hook fires → orchestrator hasn't seen it yet
if [ -n "$FROM_ORCHESTRATOR" ] && command -v orchestrator &>/dev/null; then
    orchestrator apply-handoff "$ABS_WORKDIR" 2>/dev/null || true
fi

exit "$EXIT_CODE"