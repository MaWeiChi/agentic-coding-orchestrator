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
RESULT_DIR="${RESULT_DIR:-.ai/claude-code-results}"
META_FILE="${RESULT_DIR}/task-meta.json"
TASK_OUTPUT="${RESULT_DIR}/task-output.txt"

# Defaults
PROMPT=""
TASK_NAME="adhoc-$(date +%s)"
GROUP=""
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
    PROMPT=$(npx ts-node "${SCRIPT_DIR}/../agentic-coding-orchestrator/src/cli.ts" dispatch "$FROM_ORCHESTRATOR" 2>/dev/null)
    if [ -z "$PROMPT" ]; then
        echo "Orchestrator returned no prompt (story may be done or needs human)" >&2
        exit 0
    fi
fi

if [ -z "$PROMPT" ]; then
    echo "Error: --prompt or --from-orchestrator is required" >&2
    exit 1
fi

# ---- 1. Write task metadata ----
mkdir -p "$RESULT_DIR"

cat > "$META_FILE" << EOF
{
  "task_name": "${TASK_NAME}",
  "group": "${GROUP}",
  "workdir": "$(cd "$WORKDIR" && pwd)",
  "started_at": "$(date -Iseconds)",
  "status": "running"
}
EOF

echo "Task: $TASK_NAME"
echo "Workdir: $WORKDIR"

# ---- 2. Clear previous output ----
> "$TASK_OUTPUT" 2>/dev/null || true

# ---- 3. Build claude command ----
CMD=(claude -p "$PROMPT")

if [ -n "$PERMISSION_MODE" ]; then
    CMD+=(--permission-mode "$PERMISSION_MODE")
fi
if [ -n "$ALLOWED_TOOLS" ]; then
    CMD+=(--allowedTools "$ALLOWED_TOOLS")
fi

# ---- 4. Run Claude Code ----
echo "Launching Claude Code..."
cd "$WORKDIR"
"${CMD[@]}" 2>&1 | tee "$TASK_OUTPUT"
EXIT_CODE=${PIPESTATUS[0]}

echo "Claude Code exited: $EXIT_CODE"

# ---- 5. Update meta ----
if [ -f "$META_FILE" ]; then
    TMP=$(mktemp)
    cat "$META_FILE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['exit_code'] = $EXIT_CODE
d['completed_at'] = '$(date -Iseconds)'
d['status'] = 'done'
json.dump(d, sys.stdout, indent=2)
" > "$TMP" 2>/dev/null && mv "$TMP" "$META_FILE" || rm -f "$TMP"
fi

exit $EXIT_CODE
