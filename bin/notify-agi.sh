#!/usr/bin/env bash
# notify-agi.sh — Post-hook: parse HANDOFF.md and update STATE.json
#
# Usage: bin/notify-agi.sh <project-root>
#
# Call this after the executor (Claude Code) exits. It:
#   1. Parses .ai/HANDOFF.md (YAML front matter or fallback grep)
#   2. Updates .ai/STATE.json with status, reason, test results, files_changed
#   3. Optionally runs the step's post_check command
#
# Can also be used as a Claude Code hook:
#   claude --hook "post_tool_use:bash:bin/notify-agi.sh /path/to/project"

set -euo pipefail

PROJECT_ROOT="${1:?Usage: notify-agi.sh <project-root>}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCHESTRATOR_DIR="$(dirname "$SCRIPT_DIR")"

# ── Apply HANDOFF ─────────────────────────────────────────────────────────────
echo "[notify-agi] Parsing HANDOFF.md and updating STATE.json..."

node -e "
  const { applyHandoff } = require('${ORCHESTRATOR_DIR}/dist/index.js');
  try {
    const state = applyHandoff('${PROJECT_ROOT}');
    console.log('[notify-agi] STATE updated:');
    console.log('  step:   ' + state.step);
    console.log('  status: ' + state.status);
    console.log('  reason: ' + (state.reason || '(none)'));
    if (state.tests) {
      console.log('  tests:  pass=' + state.tests.pass + ' fail=' + state.tests.fail + ' skip=' + state.tests.skip);
    }
  } catch (err) {
    console.error('[notify-agi] Error applying handoff:', err.message);
    exit(1);
  }
"

# ── Run post_check (optional) ────────────────────────────────────────────────
echo "[notify-agi] Running post_check (if defined)..."

node -e "
  const { runPostCheck } = require('${ORCHESTRATOR_DIR}/dist/index.js');
  const { execSync } = require('child_process');
  try {
    const passed = runPostCheck('${PROJECT_ROOT}', execSync);
    if (passed) {
      console.log('[notify-agi] post_check: PASSED');
    } else {
      console.log('[notify-agi] post_check: FAILED (lint_pass=false in STATE)');
    }
  } catch (err) {
    console.error('[notify-agi] post_check error:', err.message);
  }
"

echo "[notify-agi] Done."
