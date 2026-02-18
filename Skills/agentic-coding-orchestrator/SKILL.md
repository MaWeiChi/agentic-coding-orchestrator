---
name: agentic-coding-orchestrator
description: >
  Agentic Coding Framework orchestrator skill for OpenClaw. Manages the automation
  pipeline: reading STATE.json, dispatching executors, parsing HANDOFF.md, running
  hooks, and advancing the micro-waterfall lifecycle. Use this skill when building or
  configuring an orchestrator that drives AI coding agents through the framework's
  layered workflow. Trigger when the user mentions OpenClaw, orchestrator setup,
  STATE.json management, dispatch logic, hook scripts, multi-executor coordination,
  or agent team configuration.
---

# Agentic Coding Framework — Orchestrator Skill

## Installation

```bash
# npm
npm install @agentic-coding-framework/orchestrator-core

# CLI (global)
npm install -g @agentic-coding-framework/orchestrator-core
orchestrator status ./my-project

# Programmatic
import { dispatch, startCustom, startStory } from "@agentic-coding-framework/orchestrator-core";
```

### CC Hooks Setup

Copy the hook config to your Claude Code settings:

```bash
# 1. Install hooks
cp node_modules/@agentic-coding-framework/orchestrator-core/../../hooks/claude-settings.json ~/.claude/settings.json
# Or merge manually into existing settings.json

# 2. Copy shell scripts
cp node_modules/@agentic-coding-framework/orchestrator-core/../../bin/dispatch-claude-code.sh ~/.claude/hooks/
cp node_modules/@agentic-coding-framework/orchestrator-core/../../bin/notify-agi.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

## Overview

You are configuring or operating an orchestrator that drives executor
agents (such as Claude Code) through the Agentic Coding Framework's micro-waterfall
lifecycle. The orchestrator's design goal is **zero reasoning, zero LLM tokens** — all
decision logic is deterministic code: table lookup, comparison, template filling. The
executor bears the token cost for work that requires understanding.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  External Orchestrator                               │
│  • Reads STATE.json → determines next step           │
│  • Fills Dispatch Prompt template → spawns executor   │
│  • Runs pre/post hooks → advances state              │
│  • Routes based on HANDOFF.md reason field            │
│                                                       │
│  ┌─────────────────────────────────────────────┐     │
│  │  Story-Level Coordinator (for [M]/[L])      │     │
│  │  • Splits story into sub-tasks              │     │
│  │  • Assigns roles (backend/frontend/test)    │     │
│  │  • Manages per-task HANDOFF files            │     │
│  └─────────────────────────────────────────────┘     │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Executor │  │ Executor │  │ Executor │           │
│  │ (Claude) │  │ (Claude) │  │ (Claude) │           │
│  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────┘
```

The executor does not know the orchestrator exists. It simply reads project files,
follows the framework, and writes HANDOFF.md when done. The orchestrator reads that
HANDOFF and decides what happens next.

## Three-File Protocol

The orchestrator and executor communicate through exactly three files:

| File | Owner | Purpose |
|------|-------|---------|
| `.ai/STATE.json` | Orchestrator only | Machine-readable state: current story, step, attempt count, blocked status |
| `.ai/HANDOFF.md` | Executor writes, orchestrator reads | Session context: what was done, what's unresolved, reason for stopping. **Full Mode Only, latest-entry-only** — overwritten each session. Historical records archived to `.ai/history.md` |
| `.ai/history.md` | Executor appends | Session archive: DONE + LOG entries from each completed step, append-only |
| `PROJECT_MEMORY.md` | Executor writes, orchestrator reads | Cross-session project state (human-readable, tool-agnostic) |

> **Note:** The orchestrator **never touches** PROJECT_MEMORY.md or `.ai/history.md`.
> The executor **never touches** STATE.json. HANDOFF.md is the bridge — executor writes
> it, hooks parse the YAML front matter to update STATE.json.

Read `references/protocol.md` for the complete STATE.json schema, HANDOFF.md hybrid
format specification, and the step conversion rules table.

## Dispatch Logic

When the orchestrator needs to advance a step, it:

1. **Reads STATE.json** to determine current story, step, and attempt count
2. **Looks up the Step Conversion Rules table** to get: what the executor should read
   (`claude_reads`), what it should write (`claude_writes`), what post-check to run
   (`post_check`), and the maximum attempts allowed (`max_attempts`)
3. **Fills the Dispatch Prompt template** with the above information and spawns an
   executor session
4. **Waits for the executor to exit**, then reads HANDOFF.md

### Dispatch Prompt Template

```
You are working on Story {story_id}, step "{step}".
Read these files for context: {claude_reads}
Produce these outputs: {claude_writes}
After completion:
1. Update .ai/HANDOFF.md:
   - YAML front matter: fill in story, step, attempt, status, reason, files_changed, tests
   - Markdown body: record what was done, what's unresolved, what next session should note
2. If requirements unclear, fill reason field with needs_clarification
3. If Constitution violation, fill reason field with constitution_violation
```

### Complexity-Based Dispatch

| Complexity | Dispatch Strategy |
|-----------|-------------------|
| `[S]` Simple | Single executor, full micro-waterfall |
| `[M]` Medium | Auto-check: if cross-module, upgrade to `[P]` parallel; otherwise single executor |
| `[L]` Complex | Story-Level Coordinator splits into sub-tasks, assigns to role-based executor team |
| `[P]` Parallel | Multiple executors with scoped context and per-task HANDOFF files |

Read `references/protocol.md` Section "Multi-Executor Collaboration" for the full
team_roles YAML, scoped context loading rules, and per-task HANDOFF conventions.

For the complete multi-executor specification (three-layer architecture, scoped context
isolation, coordinator ↔ executor events, reference implementations), see the framework's
[Protocol-Advanced.md](https://github.com/MaWeiChi/Agentic-Coding-Framework/blob/main/Framework/Protocol-Advanced.md).

## Hook System

Hooks run deterministically (no LLM tokens) before and after each executor session.

### Pre-Hook (before dispatching executor)

```bash
# 1. Validate STATE.json — initialize with full schema if missing
if [ ! -f "$PROJECT_ROOT/.ai/STATE.json" ]; then
  cat > "$PROJECT_ROOT/.ai/STATE.json" << 'INIT'
{
  "project": "",
  "story": null,
  "step": "bootstrap",
  "attempt": 1,
  "max_attempts": 1,
  "status": "pending",
  "reason": null,
  "dispatched_at": null,
  "completed_at": null,
  "timeout_min": 5,
  "tests": null,
  "failing_tests": [],
  "lint_pass": null,
  "files_changed": [],
  "blocked_by": [],
  "human_note": null
}
INIT
fi

# 2. Check attempt count against max_attempts
ATTEMPT=$(jq '.attempt' "$PROJECT_ROOT/.ai/STATE.json")
MAX=$(lookup_max_attempts "$STEP")
if [ "$ATTEMPT" -ge "$MAX" ]; then
  # Mark as blocked, notify human
  jq '.status = "needs_human" | .blocked_by = ["max_attempts_exceeded"]' STATE.json > tmp && mv tmp STATE.json
  exit 1
fi

# 3. Increment attempt
jq '.attempt += 1' STATE.json > tmp && mv tmp STATE.json
```

### Post-Hook (after executor exits)

```bash
# 1. Run post_check (deterministic, zero tokens)
POST_CHECK=$(lookup_post_check "$STEP")
if [ -n "$POST_CHECK" ]; then
  eval "$POST_CHECK"
  if [ $? -ne 0 ]; then
    # Post-check failed: don't advance step, let dispatch retry
    exit 1
  fi
fi

# 2. Parse HANDOFF.md — YAML front matter is the primary path
HANDOFF_FILE="$PROJECT_ROOT/.ai/HANDOFF.md"
if head -1 "$HANDOFF_FILE" | grep -q '^---$'; then
  # Parse structured fields from YAML front matter
  REASON=$(sed -n '2,/^---$/p' "$HANDOFF_FILE" | grep '^reason:' | awk '{print $2}')
  STATUS=$(sed -n '2,/^---$/p' "$HANDOFF_FILE" | grep '^status:' | awk '{print $2}')
  FILES=$(sed -n '2,/^---$/p' "$HANDOFF_FILE" | grep -A50 '^files_changed:' | grep '^ *-' | sed 's/^ *- //')
  TESTS_PASS=$(sed -n '2,/^---$/p' "$HANDOFF_FILE" | grep '^tests_pass:' | awk '{print $2}')
  TESTS_FAIL=$(sed -n '2,/^---$/p' "$HANDOFF_FILE" | grep '^tests_fail:' | awk '{print $2}')
else
  # Fallback: grep markdown body for reason keywords (pre-v0.5 format)
  REASON=$(grep -o 'NEEDS CLARIFICATION\|CONSTITUTION VIOLATION\|SCOPE WARNING' \
           "$HANDOFF_FILE" | head -1)
fi

# 3. Update STATE.json with parsed results
jq --arg status "$STATUS" --arg reason "$REASON" \
   '.status = $status | .reason = (if $reason == "" then null else $reason end)' \
   STATE.json > tmp && mv tmp STATE.json

# 4. Reason-Based Routing
case "$REASON" in
  needs_clarification)
    notify_human "Story $STORY step $STEP needs clarification"
    jq '.status = "needs_human"' STATE.json > tmp && mv tmp STATE.json
    ;;
  constitution_violation)
    jq '.step = "sdd-delta" | .attempt = 1' STATE.json > tmp && mv tmp STATE.json
    ;;
  scope_warning)
    notify_human "Scope warning on Story $STORY — needs review confirmation"
    jq '.step = "review" | .attempt = 1 | .status = "needs_human"' STATE.json > tmp && mv tmp STATE.json
    ;;
  *)
    advance_step
    ;;
esac
```

## Progressive Adoption

The protocol supports three adoption levels. Start wherever you are.

### Level 0: Human as Orchestrator

You are the orchestrator. You read the executor's output, decide the next step, and
tell the executor what to do via chat. No STATE.json or hooks needed — just the
framework documents and PROJECT_MEMORY.md.

### Level 1: Semi-Automated (Hooks + Manual Dispatch)

STATE.json tracks progress. Pre/post hooks handle mechanical checks (attempt counting,
post_check, reason parsing). You still manually trigger each dispatch.

### Level 2: Fully Automated

Orchestrator reads STATE.json, auto-dispatches executors, runs hooks, routes based on
reasons, and only pauses for human Review Checkpoint or blockers. This is the target
state for orchestrator integration.

**Timeout Polling (Level 2 required):** The orchestrator must actively detect executor
timeouts. Poll STATE.json every 30 seconds:

```javascript
function pollTimeout(project) {
  const state = readJSON(`${project}/.ai/STATE.json`);
  if (state.status !== 'running') return;
  const elapsed = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
  if (elapsed > state.timeout_min) {
    state.status = 'timeout';
    state.completed_at = new Date().toISOString();
    writeJSON(`${project}/.ai/STATE.json`, state);
    notifyHuman(`Step "${state.step}" timed out after ${Math.round(elapsed)} min`);
  }
}
```

## Token Budget Reference

Estimated token consumption per single Story (Full Mode, single executor):

| Step | Estimated Tokens | Notes |
|------|-----------------|-------|
| bdd | 2,000–5,000 | Scenario complexity varies |
| sdd-delta | 3,000–8,000 | Depends on affected modules |
| contract | 1,000–3,000 | Incremental update |
| scaffold | 2,000–5,000 | Test skeleton generation |
| impl | 5,000–15,000 | Largest token consumer |
| verify | 1,000–3,000 | Triple check (read-heavy) |
| update-memory | 500–1,000 | Simple file updates |
| **Total** | **~15,000–40,000** | Per story, single executor |

Multi-executor mode multiplies executor tokens by team size, but saves coordinator
tokens by using scoped context loading.

## Executor-Result File (Optional)

As an alternative or supplement to parsing HANDOFF.md, the executor can write a
structured `.ai/executor-result` file:

```
status: pass
reason: null
summary: Timezone issue in ApplyCoupon fixed, now using UTC for comparison
```

This is more reliable than parsing HANDOFF.md because it's a flat key-value format
that requires no YAML parsing. The post-hook can read it first, falling back to
HANDOFF.md if not present. Recommended for Level 2 (fully automated) deployments.

## Custom Task Dispatch (Ad-Hoc Passthrough)

Not all tasks are User Stories. The orchestrator supports a **custom** step that
forwards any arbitrary instruction to Claude Code with full project context — no
micro-waterfall pipeline required.

Pipeline: `custom → update-memory → done`

### Usage

```bash
# CLI
orchestrator start-custom ./project "Refactor auth module into separate package"
orchestrator dispatch ./project   # prints prompt with instruction + project context

# Programmatic
import { startCustom, dispatch } from "@agentic-coding-framework/orchestrator-core";
startCustom(projectRoot, "Add rate limiting to all API endpoints");
const result = dispatch(projectRoot);
// result.prompt includes instruction + PROJECT_CONTEXT + MEMORY + SDD + Constitution
```

### Use Cases

The custom step handles any task OpenClaw encounters that doesn't fit the Story pipeline:

**Refactoring**
- Extract module: "Extract authentication logic into a separate auth package"
- Rename: "Rename all UserDTO references to UserResponse across the project"
- Restructure: "Convert class components to functional components with hooks"
- Split: "Split monolithic service.ts into domain-specific modules"

**Code Review**
- Security review: "Review src/api/ for SQL injection and XSS vulnerabilities"
- PR review: "Review PR #42 changes and list potential issues"
- Architecture review: "Evaluate whether the current module structure follows clean architecture"
- Error handling audit: "Check all error handling paths in the payment flow"

**Bug Fix (Hotfix)**
- "Fix the race condition in WebSocket reconnection logic"
- "Debug why /api/users returns 500 on empty query params"
- "Fix memory leak in event listener cleanup on component unmount"
- "Resolve deadlock in concurrent database writes"

**DevOps / Infrastructure**
- "Add GitHub Actions CI pipeline for lint + test + build"
- "Create Dockerfile and docker-compose.yml for local development"
- "Set up pre-commit hooks for linting and formatting"
- "Configure Renovate/Dependabot for automated dependency updates"
- "Add Terraform config for staging environment"

**Documentation**
- "Add JSDoc comments to all exported functions in src/api/"
- "Update README with current API endpoints and usage examples"
- "Generate OpenAPI spec from existing Express route handlers"
- "Write ADR (Architecture Decision Record) for the database migration choice"

**Testing**
- "Add unit tests for utils/validation.ts (target 90% coverage)"
- "Write integration tests for the checkout flow"
- "Add snapshot tests for all React components in src/ui/"
- "Set up E2E tests with Playwright for critical user paths"

**Dependency / Migration**
- "Upgrade React from v17 to v18, fix all breaking changes"
- "Migrate from Express to Fastify, preserve all route behavior"
- "Replace moment.js with date-fns across the project"
- "Migrate database schema: add soft delete to all entities"

**Performance**
- "Profile and optimize the dashboard query (currently 3s response time)"
- "Add Redis caching for /api/products endpoint"
- "Implement virtual scrolling for the transaction list (10k+ rows)"
- "Lazy-load all route components with React.lazy + Suspense"

**Security**
- "Add rate limiting to all authentication endpoints"
- "Implement CSRF protection for all form submissions"
- "Sanitize all user inputs against XSS in the search endpoint"
- "Add Content-Security-Policy and security headers"
- "Audit npm dependencies for known CVEs and upgrade affected packages"

**Cleanup**
- "Remove all unused imports and dead code across the project"
- "Standardize error response format across all API endpoints"
- "Replace all console.log with structured logger (winston/pino)"
- "Fix all TypeScript strict mode errors"
- "Normalize file naming convention to kebab-case"

### How It Works

1. `startCustom()` sets `task_type: "custom"`, `step: "custom"`, and stores the
   instruction in `human_note`
2. `dispatch()` picks up the custom step, builds a prompt that includes:
   - The instruction (from `human_note`)
   - Project context: `PROJECT_CONTEXT.md`, `PROJECT_MEMORY.md`, `docs/sdd.md`,
     `docs/constitution.md`, `.ai/HANDOFF.md`
   - Standard output rules (HANDOFF.md update, reason codes)
3. After the executor exits, `applyHandoff()` parses results as usual
4. On pass → advances to `update-memory` → `done`
5. On fail → retries custom step (up to `max_attempts: 3`)

The custom step uses the same three-file protocol, same HANDOFF format, same
reason-based routing as Story steps. The only difference is: it skips the
BDD → SDD → Contract → Review → Scaffold pipeline and goes straight to execution.

## Step Conversion Rules (Quick Reference)

Step names use **kebab-case**, matching the TypeScript implementation in
`agentic-coding-orchestrator/src/state.ts`.

| Step | claude_reads | claude_writes | post_check | max |
|------|-------------|---------------|------------|-----|
| bootstrap | — | PROJECT_CONTEXT, docs/sdd.md, Constitution, Memory, dir structure | — | 1 |
| bdd | Context, Memory, HANDOFF | docs/bdd/US-{id}.md | — | 3 |
| sdd-delta | Context, Memory, BDD, SDD, HANDOFF | docs/deltas/US-{id}.md | — | 3 |
| contract | SDD, Delta, existing contract, HANDOFF | docs/api/openapi.yaml | — | 2 |
| review | — | — (human step) | — | — |
| scaffold | BDD, NFR, contract, HANDOFF | tests/ scaffolding | project-specific | 2 |
| impl | BDD, SDD, contract, HANDOFF | source code | project-specific | 5 |
| verify | BDD, Delta, SDD, contract, Constitution, HANDOFF | — (check only) | — | 2 |
| update-memory | Memory, HANDOFF (+ test results in prompt) | PROJECT_MEMORY.md, .ai/history.md | — | 2 |
| custom | Context, Memory, SDD, Constitution, HANDOFF | * (any) | — | 3 |

Read `references/protocol.md` for the complete table with all fields and the full
Multi-Executor collaboration specification.

## OpenClaw Integration Guide

OpenClaw is the conversation layer between the human user and the orchestrator.
OpenClaw uses a low-cost LLM to understand user intent, then decides **what to call**:

- **Read files only** → answer from project data, zero executor cost
- **Call orchestrator function** → deterministic, zero LLM cost
- **Dispatch Claude Code** → high cost, only when code changes are needed

### Decision Matrix

When the user says something, OpenClaw should classify it into one of these categories:

| User Intent | Category | What OpenClaw Does | Cost |
|-------------|----------|-------------------|------|
| "開啟專案 A" / "Open project A" | **Query** | `readState(projectRoot)` + read `PROJECT_MEMORY.md` → summarize current status to user | Free |
| "繼續專案 B" / "Continue project B" | **Dispatch** | `dispatch(projectRoot)` → pipe prompt to Claude Code → `applyHandoff()` | Claude Code tokens |
| "這專案有沒有用 framework" / "Is this project using the framework?" | **Detect** | `detectFramework(projectRoot)` → Level 0/1/2 | Free |
| "測試狀況如何" / "How are the tests?" | **Query** | `readState(projectRoot)` → read `state.tests`, `state.failing_tests`, `state.lint_pass` | Free |
| "還有哪些可以做" / "What's left to do?" | **Query** | Read `PROJECT_MEMORY.md` → extract NEXT section items | Free |
| "幫我 refactor auth module" / "Refactor the auth module" | **Custom Dispatch** | `startCustom(projectRoot, instruction)` → `dispatch()` → Claude Code | Claude Code tokens |
| "目前在哪個步驟" / "What step are we on?" | **Query** | `readState(projectRoot)` → `state.step`, `state.status`, `state.attempt` | Free |
| "為什麼卡住了" / "Why is it blocked?" | **Query** | `readState(projectRoot)` → `state.reason`, `state.human_note`, `state.blocked_by` | Free |
| "approve" / "核准" | **Action** | `approveReview(projectRoot, humanNote?)` | Free |
| "reject，需要改 X" / "Reject, need to change X" | **Action** | `rejectReview(projectRoot, reason, note)` | Free |
| "開新 story US-007" / "Start story US-007" | **Action** | `startStory(projectRoot, "US-007")` | Free |
| "把 moment 換成 date-fns" / "Replace moment with date-fns" | **Custom Dispatch** | `startCustom(projectRoot, "Replace moment.js with date-fns")` → `dispatch()` | Claude Code tokens |
| "列出所有專案" / "List all projects" | **Query** | `listProjects(workspaceRoot)` → lists ALL projects (framework + non-framework) | Free |
| "專案 A 跟 B 的進度比較" / "Compare progress of A and B" | **Query** | `readState()` for both projects → compare step/status | Free |

### Classification Rules for OpenClaw LLM

**CRITICAL RULE: When user mentions "Claude Code" / "CC" / "cc" / "用 CC" /
"讓 CC 做" (case-insensitive), OpenClaw MUST use orchestrator flow. Non-negotiable,
regardless of project state.**
`startCustom()` and `startStory()` auto-init STATE.json if missing.

**AGENT TEAMS RULE: When user mentions "agent-teams" / "agents" / "平行" / "多 agent",
set `agentTeams: true`. CC will spawn sub-agents internally within the same session —
no extra processes needed.**

```
IF user EXPLICITLY mentions "CC" (case-insensitive)
   → ALWAYS use orchestrator flow:
     1. Detect agent-teams: "agent-teams" / "agents" / "平行" / "多 agent" → agentTeams = true
     2. startCustom(root, instruction, { agentTeams })
        or startStory(root, id, { agentTeams })
        (auto-creates .ai/STATE.json if missing)
     3. dispatch(root) → get prompt + fw_lv
     4. Pipe prompt to CC (CC spawns sub-agents internally if agentTeams = true)
     5. applyHandoff(root) → update STATE
   → Applies even with ZERO framework files

IF user asks a QUESTION about project status, progress, tests, or history
   → READ files (STATE.json, PROJECT_MEMORY.md, .ai/history.md)
   → Summarize and respond
   → DO NOT dispatch Claude Code

IF user gives an INSTRUCTION that requires code changes (without mentioning Claude Code)
   → Check if it fits a User Story (new feature with clear scope)
     YES → startStory() + dispatch()
     NO  → startCustom(instruction) + dispatch()
   → Both auto-create STATE.json if needed
   → Pipe prompt to Claude Code
   → After exit: applyHandoff()

IF user gives a COMMAND (approve, reject, start)
   → Call the corresponding orchestrator function directly
   → Respond with result

IF user asks about framework adoption
   → detectFramework(projectRoot) → Level 0/1/2
```

### Auto-Initialization

When `startStory()` or `startCustom()` is called on a project without `.ai/STATE.json`,
the orchestrator will **automatically**:

1. **Infer project name** from `package.json` → `go.mod` → directory name
2. **Create `.ai/STATE.json`** with initial state
3. **Proceed normally** with the requested task

This means **every project in the workspace is a valid target** — the framework
adopts itself on first use. No manual `initState()` needed.

### Non-Framework Projects

All query functions work on non-framework projects too:

- `queryProjectStatus()` → returns `status: "not_initialized"`, `has_framework.level: 0`
- `detectFramework()` → returns all flags as `false`, `level: 0`
- `listProjects()` → detects ANY project (package.json, go.mod, Cargo.toml, .git, etc.)

For **action** functions, auto-init kicks in:

```
User: 用 Claude Code 幫 legacy-api 做 code review
OpenClaw: [startCustom("./legacy-api", "Code review")]
         ↳ no STATE.json → auto-creates .ai/STATE.json for "legacy-api"
         [dispatch() → Claude Code → applyHandoff()]
OpenClaw: Code review 完成了，發現 8 個問題...

User: 再幫我 refactor auth module
OpenClaw: [startCustom("./legacy-api", "Refactor auth module")]
         ↳ STATE.json already exists from previous task
         [dispatch() → Claude Code → applyHandoff()]
OpenClaw: Refactor 完成了...

User: 打開 legacy-api
OpenClaw: [queryProjectStatus("./legacy-api")]
OpenClaw: legacy-api 目前在 done 步驟。上次做了 auth module refactor。
         MEMORY 裡的 NEXT 有：...
```

### Multi-Project Management

OpenClaw should maintain a workspace registry (a directory containing multiple
projects). When the user says "open project A", OpenClaw:

1. Scans the workspace with `listProjects(workspaceRoot)` — finds ALL projects
2. Matches by project name or directory name (supports both framework and non-framework)
3. Sets the active project root
4. Calls `queryProjectStatus(projectRoot)` and reports status to the user

When switching projects, OpenClaw does NOT need to dispatch anything. It just
reads the persisted state files.

### `fw_lv` in DispatchResult

When `dispatch()` returns `type: "dispatched"`, it includes `fw_lv` (framework level):

| `fw_lv` | Meaning | OpenClaw tells user |
|---------|---------|---------------------|
| `0` | No framework — CC works solo | "CC 會直接分析 code（無 framework context）" |
| `1` | Partial — some docs exist | "CC 有部分專案文件可參考" |
| `2` | Full framework | "CC 有完整專案 context" |

Level 0 tasks may take longer since CC has no prior project knowledge.

### What OpenClaw Tells the User

After dispatching Claude Code, OpenClaw should report back in human-friendly
language. Here's how to translate orchestrator results:

| DispatchResult.type | What to tell the user |
|--------------------|----------------------|
| `dispatched` | "正在執行 {step} (第 {attempt} 次)..." — check `fw_lv`: 0 = CC solo, 1 = partial ctx, 2 = full ctx |
| `done` | "Story {story} 完成了！" / "Story {story} is complete!" |
| `needs_human` | "需要你 review：{message}" / "Needs your review: {message}" |
| `blocked` | "卡住了：{reason}" / "Blocked: {reason}" |
| `already_running` | "還在執行中（已跑 {elapsed} 分鐘）" / "Still running ({elapsed} min)" |
| `timeout` | "超時了，需要你決定下一步" / "Timed out, need your input" |

### Conversation Examples

```
User: 打開我的 todo-app 專案
OpenClaw: [reads .ai/STATE.json + PROJECT_MEMORY.md]
OpenClaw: todo-app 目前在 impl 步驟，第 2 次嘗試，狀態是 failing。
         上次的問題是 test_timeout。MEMORY 裡的 NEXT 有：
         - 完成購物車結帳流程
         - 加入 Stripe 付款整合
         要繼續嗎？

User: 繼續
OpenClaw: [dispatch() → Claude Code → applyHandoff()]
OpenClaw: impl 步驟完成了，測試 pass=12 fail=0。自動進入 verify 步驟...
         verify 也通過了，正在更新 MEMORY...
         Story US-003 完成！

User: 幫我把所有 console.log 換成 structured logger
OpenClaw: [startCustom(root, "Replace all console.log with structured logger")]
         [dispatch() → Claude Code → applyHandoff()]
OpenClaw: 完成了，改了 14 個檔案，把 console.log 都換成 pino logger。
         測試全部通過。

User: 測試狀況如何？
OpenClaw: [readState() → state.tests]
OpenClaw: 最後一次測試：pass=47, fail=0, skip=3。lint 也通過了。
```

### API Surface Summary

Functions OpenClaw needs to know:

| Function | Purpose | When to Use | Works without framework? |
|----------|---------|------------|------------------------|
| `queryProjectStatus(root)` | Full status summary | "How's the project?" | ✅ Yes (returns `not_initialized`) |
| `detectFramework(root)` | Check framework adoption | "Is this using framework?" | ✅ Yes (returns Level 0) |
| `listProjects(workspace)` | List all projects | "What projects do I have?" | ✅ Yes (detects any project) |
| `readState(root)` | Read raw STATE.json | Detailed status query | ❌ Throws if no STATE.json |
| `initState(root, name)` | Initialize new project | "Create/init project" | ✅ Creates STATE.json |
| `startStory(root, id)` | Begin User Story pipeline | "Start US-007" | ❌ Needs STATE.json |
| `startCustom(root, instruction)` | Begin ad-hoc task | Any non-Story instruction | ❌ Needs STATE.json |
| `dispatch(root)` | Get next prompt / advance | After start, or "continue" | ❌ Needs STATE.json |
| `applyHandoff(root)` | Parse HANDOFF after executor | After Claude Code exits | ❌ Needs STATE.json |
| `approveReview(root, note?)` | Approve review step | "Approve" / "LGTM" | ❌ Needs STATE.json |
| `rejectReview(root, reason, note?)` | Reject review step | "Reject because..." | ❌ Needs STATE.json |

Files OpenClaw can read directly (no function needed):

| File | Contains | When to Read |
|------|----------|-------------|
| `.ai/STATE.json` | Step, status, tests, reason | Status queries |
| `PROJECT_MEMORY.md` | NOW/NEXT/DONE sections | "What's left?", "What was done?" |
| `PROJECT_CONTEXT.md` | Project purpose, tech stack | "What is this project?" |
| `.ai/HANDOFF.md` | Last session summary | "What happened last time?" |
| `.ai/history.md` | All session logs | "Show me the history" |
| `docs/constitution.md` | Architectural constraints | "What are the rules?" |
