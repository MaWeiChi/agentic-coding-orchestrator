---
name: agentic-coding-openclaw
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

You are configuring or operating an orchestrator (such as OpenClaw) that drives executor
agents (such as Claude Code) through the Agentic Coding Framework's micro-waterfall
lifecycle. The orchestrator's design goal is **zero reasoning, zero LLM tokens** — all
decision logic is deterministic code: table lookup, comparison, template filling. The
executor bears the token cost for work that requires understanding.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  External Orchestrator (OpenClaw)                    │
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
| `.ai/HANDOFF.md` | Executor writes, orchestrator reads | Session context: what was done, what's unresolved, reason for stopping |
| `PROJECT_MEMORY.md` | Executor writes, orchestrator reads | Cross-session project state (human-readable, tool-agnostic) |

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

# 2. Parse HANDOFF.md reason (prioritize YAML front matter)
HANDOFF_FILE="$PROJECT_ROOT/.ai/HANDOFF.md"
if head -1 "$HANDOFF_FILE" | grep -q '^---$'; then
  # Hybrid format: parse from YAML front matter
  REASON=$(sed -n '/^---$/,/^---$/p' "$HANDOFF_FILE" | grep '^reason:' | awk '{print $2}')
  STATUS=$(sed -n '/^---$/,/^---$/p' "$HANDOFF_FILE" | grep '^status:' | awk '{print $2}')
else
  # Fallback: old format, grep markdown body
  REASON=$(grep -o 'NEEDS CLARIFICATION\|CONSTITUTION VIOLATION\|SCOPE WARNING' \
           "$HANDOFF_FILE" | head -1)
fi

# 3. Reason-Based Routing
case "$REASON" in
  needs_clarification)
    # Pause pipeline, wait for human
    notify_human "Story $STORY step $STEP needs clarification"
    jq '.status = "needs_human"' STATE.json > tmp && mv tmp STATE.json
    ;;
  constitution_violation)
    # Route back to sdd-delta for redesign
    jq '.step = "sdd-delta" | .attempt = 1' STATE.json > tmp && mv tmp STATE.json
    ;;
  scope_warning)
    # Route to review for human confirmation (Protocol: scope_warning → review)
    notify_human "Scope warning on Story $STORY — needs review confirmation"
    jq '.step = "review" | .attempt = 1 | .status = "needs_human"' STATE.json > tmp && mv tmp STATE.json
    ;;
  *)
    # Normal completion: advance to next step
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
state for OpenClaw integration.

## Step Conversion Rules (Quick Reference)

Step names use **kebab-case**, matching the TypeScript implementation in
`agentic-coding-openclaw/src/state.ts`.

| Step | claude_reads | claude_writes | post_check | max |
|------|-------------|---------------|------------|-----|
| bootstrap | — | PROJECT_CONTEXT, SDD skeleton, Constitution, Memory, dir structure | — | 1 |
| bdd | Context, Memory, SDD, HANDOFF | docs/bdd/US-{id}.md | — | 3 |
| sdd-delta | Context, Memory, BDD, SDD, HANDOFF | docs/deltas/US-{id}.md | — | 3 |
| contract | SDD, Delta, existing contract, HANDOFF | docs/api/openapi.yaml | — | 2 |
| review | — | — (human step) | — | — |
| scaffold | BDD, NFR, contract, HANDOFF | tests/ scaffolding | project-specific | 2 |
| impl | BDD, SDD, contract, HANDOFF | source code | project-specific | 5 |
| verify | BDD, Delta, SDD, contract, Constitution, HANDOFF | — (check only) | — | 2 |
| update-memory | Memory (+ test results injected in prompt) | PROJECT_MEMORY.md | — | 2 |

Read `references/protocol.md` for the complete table with all fields and the full
Multi-Executor collaboration specification.
