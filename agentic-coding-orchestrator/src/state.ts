/**
 * state.ts — STATE.json Type Definitions + Read / Write / Validate
 *
 * Maps directly to the Agentic Coding Protocol's STATE.json field specifications.
 * All operations are synchronous file I/O — zero LLM tokens.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestResults {
  pass: number;
  fail: number;
  skip: number;
}

export interface State {
  project: string;
  story: string | null;
  step: string;
  attempt: number;
  max_attempts: number;
  status: string;
  reason: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
  timeout_min: number;
  tests: TestResults | null;
  failing_tests: string[];
  lint_pass: boolean | null;
  files_changed: string[];
  blocked_by: string[];
  human_note: string | null;
  task_type: string;
  agent_teams: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Create a blank STATE.json for a new project */
export function createInitialState(project: string): State {
  return {
    project,
    story: null,
    step: "bootstrap",
    attempt: 1,
    max_attempts: 1,
    status: "pending",
    reason: null,
    dispatched_at: null,
    completed_at: null,
    timeout_min: 5,
    tests: null,
    failing_tests: [],
    lint_pass: null,
    files_changed: [],
    blocked_by: [],
    human_note: null,
    task_type: "story",
    agent_teams: false,
  };
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/** Resolve the STATE.json path for a project root */
export function statePath(projectRoot: string): string {
  return join(projectRoot, ".ai", "STATE.json");
}

/** Read STATE.json from disk. Throws if file doesn't exist. */
export function readState(projectRoot: string): State {
  const path = statePath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`STATE.json not found at ${path}. Run initState() first.`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  validate(parsed);
  return parsed;
}

/** Write STATE.json to disk. Creates .ai/ directory if needed. */
export function writeState(projectRoot: string, state: State): void {
  validate(state);
  const path = statePath(projectRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Initialize .ai/STATE.json for a new project. No-op if already exists. */
export function initState(
  projectRoot: string,
  project: string,
): { created: boolean; state: State } {
  const path = statePath(projectRoot);
  if (existsSync(path)) {
    return { created: false, state: readState(projectRoot) };
  }
  const state = createInitialState(project);
  writeState(projectRoot, state);
  return { created: true, state };
}

// ─── CLAUDE.md Generation ─────────────────────────────────────────────────

/** Path to CLAUDE.md in project root */
export function claudeMdPath(projectRoot: string): string {
  return join(projectRoot, "CLAUDE.md");
}

/**
 * Generate CLAUDE.md content for ACF-enabled projects.
 * CC reads this file automatically on every session start,
 * ensuring it follows the ACF workflow even without dispatch.
 */
export function generateClaudeMd(project: string): string {
  return `# ${project} — Agentic Coding Framework

This project uses the **Agentic Coding Framework (ACF)** with an orchestrator-driven
micro-waterfall pipeline. You MUST follow the ACF workflow — do NOT work freestyle.

## How to Work in This Project

1. **Check current state first:**
   Read \`.ai/STATE.json\` to understand which step and status the project is in.

2. **Follow the orchestrator — never skip steps:**
   The pipeline is: bootstrap → bdd → sdd-delta → contract → review → scaffold → impl → verify → update-memory → done.
   Each step has specific inputs, outputs, and acceptance criteria.

3. **Use the orchestrator CLI** (preferred):
   \`\`\`bash
   orchestrator dispatch .       # Get your current task prompt
   orchestrator status .         # Check pipeline status
   \`\`\`

4. **Always update .ai/HANDOFF.md when done:**
   After completing your work, write a YAML front-matter summary to \`.ai/HANDOFF.md\`
   with: story, step, attempt, status (pass/failing), reason, files_changed, and tests.
   The orchestrator hook reads this to advance the pipeline.

## Key Rules

- **Do NOT modify .ai/STATE.json directly** — the orchestrator manages it.
- **Do NOT skip to a different step** — always complete the current step first.
- If requirements are unclear, set status: \`failing\` and reason: \`needs_clarification\` in HANDOFF.md.
- If you find a Constitution violation, set reason: \`constitution_violation\`.
- Read \`.ai/PROJECT_MEMORY.md\` for cross-session context and architectural decisions.

## Files

| File | Purpose | Who writes |
|------|---------|-----------|
| \`.ai/STATE.json\` | Pipeline state machine | Orchestrator only |
| \`.ai/HANDOFF.md\` | Executor ↔ Orchestrator bridge | You (CC) |
| \`.ai/PROJECT_MEMORY.md\` | Cross-session knowledge | You (at update-memory step) |
`;
}

/**
 * Write CLAUDE.md to project root.
 * Returns true if created, false if already exists (no overwrite).
 */
export function writeClaudeMd(
  projectRoot: string,
  project: string,
  force = false,
): boolean {
  const path = claudeMdPath(projectRoot);
  if (existsSync(path) && !force) {
    return false;
  }
  writeFileSync(path, generateClaudeMd(project), "utf-8");
  return true;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_STEPS = new Set([
  "bootstrap",
  "bdd",
  "sdd-delta",
  "contract",
  "review",
  "scaffold",
  "impl",
  "verify",
  "update-memory",
  "custom",
  "done",
]);

const VALID_STATUSES = new Set([
  "pending",
  "running",
  "pass",
  "failing",
  "needs_human",
  "timeout",
]);

const VALID_REASONS = new Set([
  "constitution_violation",
  "needs_clarification",
  "nfr_missing",
  "scope_warning",
  "test_timeout",
]);

/** Validate a State object. Throws on invalid fields. */
export function validate(state: State): void {
  if (!state.project) {
    throw new Error("State.project is required");
  }
  if (!VALID_STEPS.has(state.step)) {
    throw new Error(
      `Invalid step: "${state.step}". Valid: ${[...VALID_STEPS].join(", ")}`,
    );
  }
  if (!VALID_STATUSES.has(state.status)) {
    throw new Error(
      `Invalid status: "${state.status}". Valid: ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  if (state.reason !== null && !VALID_REASONS.has(state.reason)) {
    throw new Error(
      `Invalid reason: "${state.reason}". Valid: null, ${[...VALID_REASONS].join(", ")}`,
    );
  }
  if (state.attempt < 0) {
    throw new Error(`attempt must be >= 0, got ${state.attempt}`);
  }
  if (state.max_attempts < 1) {
    throw new Error(`max_attempts must be >= 1, got ${state.max_attempts}`);
  }
}

// ─── Convenience Helpers ─────────────────────────────────────────────────────

/** Check if a step has exceeded its timeout */
export function isTimedOut(state: State): boolean {
  if (state.status !== "running" || !state.dispatched_at) return false;
  const elapsed =
    (Date.now() - new Date(state.dispatched_at).getTime()) / 60_000;
  return elapsed > state.timeout_min;
}

/** Check if current step has exhausted all attempts */
export function isMaxedOut(state: State): boolean {
  return state.attempt >= state.max_attempts;
}

/** Mark state as running with dispatch timestamp */
export function markRunning(state: State): State {
  return {
    ...state,
    status: "running",
    dispatched_at: new Date().toISOString(),
    completed_at: null,
    reason: null,
  };
}

/** Mark state as completed (pass or failing) with timestamp */
export function markCompleted(
  state: State,
  status: string,
  reason: string | null = null,
): State {
  return {
    ...state,
    status,
    reason,
    completed_at: new Date().toISOString(),
  };
}
