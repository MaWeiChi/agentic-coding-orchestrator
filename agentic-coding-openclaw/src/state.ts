/**
 * state.ts — STATE.json Type Definitions + Read / Write / Validate
 *
 * Maps directly to the Agentic Coding Protocol's STATE.json field specifications.
 * All operations are synchronous file I/O — zero LLM tokens.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─── Type Definitions ────────────────────────────────────────────────────────

/** Micro-waterfall steps, matching Protocol's valid step values */
export type Step =
  | "bootstrap"
  | "bdd"
  | "sdd-delta"
  | "contract"
  | "review"
  | "scaffold"
  | "impl"
  | "verify"
  | "update-memory"
  | "done";

/** STATE.json status state machine:
 *  pending → running → pass | failing | timeout | needs_human */
export type Status =
  | "pending"
  | "running"
  | "pass"
  | "failing"
  | "needs_human"
  | "timeout";

/** Reason codes extracted from HANDOFF.md, driving reason-based routing */
export type Reason =
  | "constitution_violation"
  | "needs_clarification"
  | "nfr_missing"
  | "scope_warning"
  | "test_timeout";

/** Test result summary */
export interface TestResult {
  pass: number;
  fail: number;
  skip: number;
}

/** Complete STATE.json schema — every field from the Protocol spec */
export interface State {
  /** Project identifier */
  project: string;
  /** Current User Story ID (e.g., "US-005") */
  story: string | null;

  // ── Step tracking ──
  /** Current micro-waterfall step */
  step: Step;
  /** Attempt count for current step (1-indexed) */
  attempt: number;
  /** Maximum attempts allowed (from rules table) */
  max_attempts: number;
  /** Current status */
  status: Status;
  /** Failure reason code (null = general failure/success) */
  reason: Reason | null;

  // ── Timing ──
  /** ISO 8601 timestamp when executor was dispatched */
  dispatched_at: string | null;
  /** ISO 8601 timestamp when executor completed */
  completed_at: string | null;
  /** Timeout in minutes (from rules table) */
  timeout_min: number;

  // ── Results ──
  /** Test result summary */
  tests: TestResult | null;
  /** Names of failing tests */
  failing_tests: string[];
  /** Whether linting passed */
  lint_pass: boolean | null;
  /** Files modified in this run */
  files_changed: string[];

  // ── Human interaction ──
  /** Story IDs that block this story */
  blocked_by: string[];
  /** Human instruction transcribed from communication channel */
  human_note: string | null;
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
  const parsed = JSON.parse(raw) as State;
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
  project: string
): { created: boolean; state: State } {
  const path = statePath(projectRoot);
  if (existsSync(path)) {
    return { created: false, state: readState(projectRoot) };
  }
  const state = createInitialState(project);
  writeState(projectRoot, state);
  return { created: true, state };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_STEPS: Set<string> = new Set<Step>([
  "bootstrap",
  "bdd",
  "sdd-delta",
  "contract",
  "review",
  "scaffold",
  "impl",
  "verify",
  "update-memory",
  "done",
]);

const VALID_STATUSES: Set<string> = new Set<Status>([
  "pending",
  "running",
  "pass",
  "failing",
  "needs_human",
  "timeout",
]);

const VALID_REASONS: Set<string> = new Set<Reason>([
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
    throw new Error(`Invalid step: "${state.step}". Valid: ${[...VALID_STEPS].join(", ")}`);
  }
  if (!VALID_STATUSES.has(state.status)) {
    throw new Error(
      `Invalid status: "${state.status}". Valid: ${[...VALID_STATUSES].join(", ")}`
    );
  }
  if (state.reason !== null && !VALID_REASONS.has(state.reason)) {
    throw new Error(
      `Invalid reason: "${state.reason}". Valid: null, ${[...VALID_REASONS].join(", ")}`
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
  const elapsed = (Date.now() - new Date(state.dispatched_at).getTime()) / 60_000;
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
  status: "pass" | "failing" | "needs_human",
  reason: Reason | null = null
): State {
  return {
    ...state,
    status,
    reason,
    completed_at: new Date().toISOString(),
  };
}
