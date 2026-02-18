#!/usr/bin/env bash
# dispatch-claude-code.sh — Dispatch next step via Claude Code CLI
#
# Usage: bin/dispatch-claude-code.sh <project-root>
#
# This script:
#   1. Calls the orchestrator's dispatch() to get the next prompt
#   2. Spawns a Claude Code session with that prompt
#   3. After Claude exits, calls applyHandoff() to update STATE.json
#   4. Optionally runs post_check if defined for the step

set -euo pipefail

PROJECT_ROOT="${1:?Usage: dispatch-claude-code.sh <project-root>}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCHESTRATOR_DIR="$(dirname "$SCRIPT_DIR")"

# ── Step 1: Dispatch ──────────────────────────────────────────────────────────
echo "[orchestrator] Dispatching next step..."

DISPATCH_OUTPUT=$(node -e "
  const { dispatch } = require('${ORCHESTRATOR_DIR}/dist/index.js');
  const result = dispatch('${PROJECT_ROOT}');
  console.log(JSON.stringify(result));
")

TYPE=$(echo "$DISPATCH_OUTPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.type);
")

case "$TYPE" in
  dispatched)
    STEP=$(echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.step);
    ")
    ATTEMPT=$(echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.attempt);
    ")
    PROMPT=$(echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.prompt);
    ")
    echo "[orchestrator] Step: $STEP (attempt $ATTEMPT)"
    ;;
  done)
    echo "[orchestrator] Story complete!"
    echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.summary);
    "
    exit 0
    ;;
  needs_human)
    echo "[orchestrator] Waiting for human review."
    echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.message);
    "
    exit 0
    ;;
  blocked)
    echo "[orchestrator] BLOCKED"
    echo "$DISPATCH_OUTPUT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.reason);
    "
    exit 1
    ;;
  already_running)
    echo "[orchestrator] Executor is already running."
    exit 0
    ;;
  timeout)
    echo "[orchestrator] Executor timed out. Will retry on next dispatch."
    exit 1
    ;;
  *)
    echo "[orchestrator] Unknown dispatch result: $TYPE"
    exit 1
    ;;
esac

# ── Step 2: Invoke Claude Code ────────────────────────────────────────────────
echo "[orchestrator] Spawning Claude Code session..."

# Write prompt to temp file (avoids shell quoting issues with large prompts)
PROMPT_FILE=$(mktemp)
echo "$PROMPT" > "$PROMPT_FILE"

# claude -p reads prompt from stdin, --output-format stream-json for structured output
# Adjust flags as needed for your Claude Code version
claude -p "$(cat "$PROMPT_FILE")" \
  --allowedTools "Edit,Write,Bash(git*),Bash(npm*),Bash(npx*),Read,Glob,Grep" \
  2>&1 || true

rm -f "$PROMPT_FILE"

# ── Step 3: Post-hook (apply HANDOFF) ────────────────────────────────────────
echo "[orchestrator] Applying HANDOFF results..."
"$SCRIPT_DIR/notify-agi.sh" "$PROJECT_ROOT"

echo "[orchestrator] Dispatch cycle complete."
