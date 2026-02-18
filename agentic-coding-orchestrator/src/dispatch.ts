/**
 * dispatch.ts — Orchestrator State Machine + Prompt Builder + Handoff Parser
 *
 * The only file with logic. Combines state.ts (read/write) and rules.ts (lookup)
 * to drive the micro-waterfall pipeline. All decisions are deterministic —
 * zero LLM tokens.
 *
 * Main entry point: dispatch(projectRoot)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

import {
  type State,
  type Step,
  type Status,
  type Reason,
  readState,
  writeState,
  isTimedOut,
  isMaxedOut,
  markRunning,
  markCompleted,
} from "./state";

import {
  type StepRule,
  getRule,
  resolvePaths,
  getFailTarget,
} from "./rules";

// ─── Dispatch Result Types ───────────────────────────────────────────────────

export type DispatchResult =
  | { type: "dispatched"; step: Step; attempt: number; prompt: string; fw_lv: 0 | 1 | 2 }
  | { type: "blocked"; step: Step; reason: string }
  | { type: "needs_human"; step: Step; message: string }
  | { type: "done"; story: string; summary: string }
  | { type: "already_running"; step: Step; elapsed_min: number }
  | { type: "timeout"; step: Step; elapsed_min: number };

// ─── Main Dispatch Function ──────────────────────────────────────────────────

/**
 * Core dispatch logic — direct translation of Protocol's dispatch(project).
 *
 * Reads STATE.json, applies the step rules table, and returns a DispatchResult
 * telling the caller what to do next. The caller is responsible for actually
 * invoking the executor (e.g., spawning a Claude Code session).
 *
 * This function updates STATE.json as a side effect (marks running, advances
 * steps, etc.).
 */
export function dispatch(projectRoot: string): DispatchResult {
  const state = readState(projectRoot);

  // ── Story complete ──
  if (state.step === "done") {
    return {
      type: "done",
      story: state.story ?? "(no story)",
      summary: `Story ${state.story} completed.`,
    };
  }

  const rule = getRule(state.step);

  // ── Timeout check ──
  if (state.status === "running") {
    if (isTimedOut(state)) {
      state.status = "timeout";
      state.completed_at = new Date().toISOString();
      writeState(projectRoot, state);
      const elapsed = elapsedMinutes(state.dispatched_at!);
      return {
        type: "timeout",
        step: state.step,
        elapsed_min: elapsed,
      };
    }
    // Still running
    return {
      type: "already_running",
      step: state.step,
      elapsed_min: elapsedMinutes(state.dispatched_at!),
    };
  }

  // ── Requires human (review checkpoint) ──
  if (rule.requires_human && state.status !== "pass") {
    if (state.status !== "needs_human") {
      state.status = "needs_human";
      writeState(projectRoot, state);
    }
    return {
      type: "needs_human",
      step: state.step,
      message: formatReviewRequest(state),
    };
  }

  // ── Success → advance to next step ──
  if (state.status === "pass") {
    state.step = rule.next_on_pass;
    state.attempt = 1;
    state.status = "pending";
    state.reason = null;
    state.human_note = null;
    state.tests = null;
    state.failing_tests = [];
    state.lint_pass = null;
    state.files_changed = [];

    // Check if we just reached "done"
    if (state.step === "done") {
      writeState(projectRoot, state);
      return {
        type: "done",
        story: state.story ?? "(no story)",
        summary: `Story ${state.story} completed. All steps passed.`,
      };
    }

    // Recurse: the new step might also require human
    const newRule = getRule(state.step);
    if (newRule.requires_human) {
      state.status = "needs_human";
      writeState(projectRoot, state);
      return {
        type: "needs_human",
        step: state.step,
        message: formatReviewRequest(state),
      };
    }

    // Update max_attempts and timeout from new step's rule
    state.max_attempts = newRule.max_attempts;
    state.timeout_min = newRule.timeout_min;
  }

  // ── Failure → reason-based routing or retry ──
  if (state.status === "failing") {
    if (isMaxedOut(state)) {
      state.status = "needs_human";
      writeState(projectRoot, state);
      return {
        type: "blocked",
        step: state.step,
        reason: `Max attempts (${state.max_attempts}) exhausted at step "${state.step}". ` +
          (state.reason ? `Last reason: ${state.reason}` : "No specific reason."),
      };
    }

    const target = getFailTarget(state.step, state.reason);
    if (target !== state.step) {
      // Route to different step
      state.step = target;
      state.attempt = 1;
      const targetRule = getRule(target);
      state.max_attempts = targetRule.max_attempts;
      state.timeout_min = targetRule.timeout_min;
    } else {
      // Retry same step
      state.attempt++;
    }
    state.status = "pending";
  }

  // ── Dispatch executor ──
  const currentRule = getRule(state.step);
  const prompt = buildPrompt(state, currentRule);

  const running = markRunning(state);
  writeState(projectRoot, running);

  // Detect framework adoption level so caller knows the context richness
  const framework = detectFramework(projectRoot);

  return {
    type: "dispatched",
    step: running.step,
    attempt: running.attempt,
    prompt,
    fw_lv: framework.level,
  };
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

/**
 * Build the dispatch prompt from the template.
 * Pure template filling — zero LLM reasoning.
 */
export function buildPrompt(state: State, rule: StepRule): string {
  const storyId = state.story ?? "BOOTSTRAP";
  const reads = resolvePaths(rule.claude_reads, storyId);

  const lines: string[] = [];

  // Header
  lines.push(`You are executing step "${rule.display_name}" for ${storyId}.`);
  if (state.attempt > 1) {
    lines.push(`(Attempt ${state.attempt} of ${state.max_attempts})`);
  }
  lines.push("");

  // Files to read
  if (reads.length > 0) {
    lines.push("Please read the following files in order:");
    for (const file of reads) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  // Human note
  if (state.human_note) {
    lines.push("=== Human Instruction ===");
    lines.push(state.human_note);
    lines.push("==========================");
    lines.push("");
  }

  // Previous failure context
  if (state.attempt > 1 && state.failing_tests.length > 0) {
    lines.push("Previous attempt had these failing tests:");
    for (const t of state.failing_tests) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  // Inject test results for update-memory step (replaces STATE.json reading)
  if (state.step === "update-memory" && state.tests) {
    lines.push("Test results from this Story:");
    lines.push(`- Pass: ${state.tests.pass}, Fail: ${state.tests.fail}, Skip: ${state.tests.skip}`);
    if (state.files_changed.length > 0) {
      lines.push(`- Files changed: ${state.files_changed.join(", ")}`);
    }
    lines.push("");
  }

  // Step instruction
  lines.push(rule.step_instruction);
  lines.push("");

  // Output rules (always appended)
  lines.push("Output rules:");
  lines.push("- Only modify affected files and paragraphs, don't rewrite unrelated content");
  lines.push("- After completion, update .ai/HANDOFF.md:");
  lines.push(
    "  - YAML front matter: fill in story, step, attempt, status, reason, files_changed, tests values"
  );
  lines.push(
    "  - Markdown body: record what was done, what's unresolved, what next session should note"
  );
  lines.push("- If requirements unclear, fill reason field with needs_clarification");
  lines.push(
    "- If Constitution violation found, fill reason field with constitution_violation"
  );
  lines.push(
    "- If touching Non-Goals scope, fill reason field with scope_warning"
  );

  return lines.join("\n");
}

// ─── HANDOFF.md Parser ───────────────────────────────────────────────────────

/** Parsed result from HANDOFF.md's YAML front matter */
export interface HandoffResult {
  story: string | null;
  step: string | null;
  attempt: number | null;
  status: Status | null;
  reason: Reason | null;
  files_changed: string[];
  tests_pass: number | null;
  tests_fail: number | null;
  tests_skip: number | null;
  /** The markdown body (everything after the second ---) */
  body: string;
}

/**
 * Parse HANDOFF.md — prioritize YAML front matter, fallback to grep.
 * Direct translation of Protocol's hook pseudocode.
 */
export function parseHandoff(projectRoot: string): HandoffResult | null {
  const handoffPath = join(projectRoot, ".ai", "HANDOFF.md");
  if (!existsSync(handoffPath)) return null;

  const content = readFileSync(handoffPath, "utf-8");
  const lines = content.split("\n");

  // Check for YAML front matter
  if (lines[0]?.trim() === "---") {
    return parseYamlFrontMatter(content);
  }

  // Fallback: grep markdown body for reason keywords
  return parseFallback(content);
}

/** Parse YAML front matter format (hybrid HANDOFF.md) */
function parseYamlFrontMatter(content: string): HandoffResult {
  const parts = content.split("---");
  // parts[0] = "" (before first ---), parts[1] = YAML, parts[2+] = body
  const yamlBlock = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();

  const yaml = parseSimpleYaml(yamlBlock);

  return {
    story: yaml["story"] ?? null,
    step: yaml["step"] ?? null,
    attempt: yaml["attempt"] ? parseInt(yaml["attempt"], 10) : null,
    status: (yaml["status"] as Status) ?? null,
    reason: (yaml["reason"] || null) as Reason | null,
    files_changed: parseYamlList(yaml["files_changed"]),
    tests_pass: yaml["tests_pass"] ? parseInt(yaml["tests_pass"], 10) : null,
    tests_fail: yaml["tests_fail"] ? parseInt(yaml["tests_fail"], 10) : null,
    tests_skip: yaml["tests_skip"] ? parseInt(yaml["tests_skip"], 10) : null,
    body,
  };
}

/** Fallback parser: grep for reason keywords in markdown body */
function parseFallback(content: string): HandoffResult {
  const reasonMap: Record<string, Reason> = {
    "NEEDS CLARIFICATION": "needs_clarification",
    "CONSTITUTION VIOLATION": "constitution_violation",
    "SCOPE WARNING": "scope_warning",
  };

  let reason: Reason | null = null;
  for (const [keyword, code] of Object.entries(reasonMap)) {
    if (content.includes(keyword)) {
      reason = code;
      break;
    }
  }

  return {
    story: null,
    step: null,
    attempt: null,
    status: reason ? "failing" : "pass",
    reason,
    files_changed: [],
    tests_pass: null,
    tests_fail: null,
    tests_skip: null,
    body: content,
  };
}

/**
 * Minimal YAML parser for flat key: value pairs.
 * Handles simple scalars and inline lists. NOT a full YAML parser —
 * just enough for HANDOFF.md front matter.
 */
function parseSimpleYaml(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  let currentKey: string | null = null;
  let listValues: string[] = [];

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // List item (indented "- value")
    if (trimmed.startsWith("- ") && currentKey) {
      listValues.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous list
    if (currentKey && listValues.length > 0) {
      result[currentKey] = JSON.stringify(listValues);
      listValues = [];
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      currentKey = key;
      if (value) {
        // "null" → empty
        result[key] = value === "null" ? "" : value;
        currentKey = null; // not expecting list items
      }
      // else: value on next lines (list)
    }
  }

  // Flush trailing list
  if (currentKey && listValues.length > 0) {
    result[currentKey] = JSON.stringify(listValues);
  }

  return result;
}

/** Parse a YAML list value (either JSON-encoded string[] or empty) */
function parseYamlList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value ? [value] : [];
  }
}

// ─── Post-Hook: Apply HANDOFF Results to STATE ───────────────────────────────

/**
 * After executor exits, read HANDOFF.md and update STATE.json accordingly.
 * This is the TypeScript equivalent of the Protocol's post-execution hook.
 *
 * Call this after the executor process exits, before the next dispatch().
 */
export function applyHandoff(projectRoot: string): State {
  const state = readState(projectRoot);
  const handoff = parseHandoff(projectRoot);

  if (!handoff) {
    // No HANDOFF.md — executor might have crashed
    state.status = "failing";
    state.reason = null;
    state.completed_at = new Date().toISOString();
    writeState(projectRoot, state);
    return state;
  }

  // Apply structured fields from HANDOFF
  if (handoff.status) {
    state.status = handoff.status;
  } else {
    // Infer: if tests_fail > 0, it's failing
    state.status =
      handoff.tests_fail && handoff.tests_fail > 0 ? "failing" : "pass";
  }

  state.reason = handoff.reason;
  state.completed_at = new Date().toISOString();

  if (handoff.files_changed.length > 0) {
    state.files_changed = handoff.files_changed;
  }

  if (
    handoff.tests_pass !== null ||
    handoff.tests_fail !== null ||
    handoff.tests_skip !== null
  ) {
    state.tests = {
      pass: handoff.tests_pass ?? 0,
      fail: handoff.tests_fail ?? 0,
      skip: handoff.tests_skip ?? 0,
    };
    state.failing_tests = []; // could extract from body if needed
  }

  writeState(projectRoot, state);
  return state;
}

// ─── Post-Check Runner ───────────────────────────────────────────────────────

/**
 * Run the post_check command for the current step.
 * Returns true if check passed (or no check defined), false if failed.
 *
 * This is a synchronous shell execution — zero LLM tokens.
 */
export function runPostCheck(
  projectRoot: string,
  execSync: (cmd: string, opts: object) => Buffer
): boolean {
  const state = readState(projectRoot);
  const rule = getRule(state.step);

  if (!rule.post_check) return true;

  try {
    execSync(rule.post_check, {
      cwd: projectRoot,
      stdio: "pipe",
      timeout: 60_000,
    });
    state.lint_pass = true;
    writeState(projectRoot, state);
    return true;
  } catch {
    state.lint_pass = false;
    writeState(projectRoot, state);
    return false;
  }
}

// ─── Human Review Approval ───────────────────────────────────────────────────

/**
 * Mark the review step as approved by human.
 * Optionally attach a human note (modification requests, clarifications).
 */
export function approveReview(
  projectRoot: string,
  humanNote?: string
): void {
  const state = readState(projectRoot);
  if (state.step !== "review") {
    throw new Error(
      `Cannot approve review: current step is "${state.step}", not "review"`
    );
  }
  state.status = "pass";
  state.human_note = humanNote ?? null;
  writeState(projectRoot, state);
}

/**
 * Reject the review with a reason and optional note.
 */
export function rejectReview(
  projectRoot: string,
  reason: Reason,
  humanNote?: string
): void {
  const state = readState(projectRoot);
  if (state.step !== "review") {
    throw new Error(
      `Cannot reject review: current step is "${state.step}", not "review"`
    );
  }
  state.status = "failing";
  state.reason = reason;
  state.human_note = humanNote ?? null;
  writeState(projectRoot, state);
}

// ─── Auto-Init Helper ────────────────────────────────────────────────────────

/**
 * Ensure STATE.json exists. If not, auto-initialize it.
 * This allows startStory() and startCustom() to work on ANY project,
 * even if the Agentic Coding Framework hasn't been set up yet.
 *
 * Project name is inferred from: package.json name → go.mod module →
 * directory name (in that order).
 */
function ensureState(projectRoot: string): State {
  const path = join(projectRoot, ".ai", "STATE.json");
  if (existsSync(path)) {
    return readState(projectRoot);
  }

  // Infer project name
  let projectName = projectRoot.split("/").filter(Boolean).pop() ?? "project";

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) projectName = pkg.name;
    } catch { /* ignore */ }
  }

  const goModPath = join(projectRoot, "go.mod");
  if (existsSync(goModPath)) {
    try {
      const goMod = readFileSync(goModPath, "utf-8");
      const moduleLine = goMod.split("\n").find((l: string) => l.startsWith("module "));
      if (moduleLine) {
        const parts = moduleLine.replace("module ", "").trim().split("/");
        projectName = parts[parts.length - 1] ?? projectName;
      }
    } catch { /* ignore */ }
  }

  const { state } = initState(projectRoot, projectName);
  return state;
}

// ─── Start New Story ─────────────────────────────────────────────────────────

/**
 * Begin a new User Story. Resets state to bdd step with attempt 1.
 * Auto-initializes STATE.json if the project hasn't adopted the framework yet.
 */
export function startStory(projectRoot: string, storyId: string): State {
  const state = ensureState(projectRoot);
  const rule = getRule("bdd");

  state.story = storyId;
  state.step = "bdd";
  state.attempt = 1;
  state.max_attempts = rule.max_attempts;
  state.status = "pending";
  state.reason = null;
  state.dispatched_at = null;
  state.completed_at = null;
  state.timeout_min = rule.timeout_min;
  state.tests = null;
  state.failing_tests = [];
  state.lint_pass = null;
  state.files_changed = [];
  state.blocked_by = [];
  state.human_note = null;

  writeState(projectRoot, state);
  return state;
}

// ─── Query Functions (for OpenClaw LLM — zero executor cost) ─────────────────

/**
 * Get a human-friendly project status summary.
 * OpenClaw calls this when the user asks "how's the project?" or "open project X".
 *
 * Returns structured data that OpenClaw LLM can translate to natural language.
 */
export interface ProjectStatus {
  project: string;
  task_type: string;
  story: string | null;
  step: string;
  status: string;
  attempt: number;
  max_attempts: number;
  reason: string | null;
  tests: { pass: number; fail: number; skip: number } | null;
  lint_pass: boolean | null;
  files_changed: string[];
  blocked_by: string[];
  human_note: string | null;
  memory_summary: string | null;
  has_framework: FrameworkDetection;
}

export interface FrameworkDetection {
  has_state: boolean;
  has_memory: boolean;
  has_context: boolean;
  has_constitution: boolean;
  has_sdd: boolean;
  has_handoff: boolean;
  has_history: boolean;
  /** Adoption level: 0 = none, 1 = partial (some files), 2 = full (all core files) */
  level: 0 | 1 | 2;
}

/**
 * Detect whether a project uses the Agentic Coding Framework.
 * OpenClaw calls this when the user asks "is this project using the framework?"
 */
export function detectFramework(projectRoot: string): FrameworkDetection {
  const check = (p: string) => existsSync(join(projectRoot, p));

  const has_state = check(".ai/STATE.json");
  const has_memory = check("PROJECT_MEMORY.md");
  const has_context = check("PROJECT_CONTEXT.md");
  const has_constitution = check("docs/constitution.md");
  const has_sdd = check("docs/sdd.md");
  const has_handoff = check(".ai/HANDOFF.md");
  const has_history = check(".ai/history.md");

  const core = [has_state, has_memory, has_context, has_constitution, has_sdd];
  const coreCount = core.filter(Boolean).length;

  let level: 0 | 1 | 2 = 0;
  if (coreCount === core.length) level = 2;
  else if (coreCount > 0) level = 1;

  return {
    has_state, has_memory, has_context, has_constitution,
    has_sdd, has_handoff, has_history, level,
  };
}

/**
 * Get comprehensive project status for OpenClaw to summarize to the user.
 * Works for ANY project — with or without the Agentic Coding Framework.
 *
 * - Framework project (has STATE.json): returns full state + memory summary
 * - Non-framework project: returns framework detection + whatever files exist
 */
export function queryProjectStatus(projectRoot: string): ProjectStatus {
  const framework = detectFramework(projectRoot);

  // Read MEMORY summary if it exists
  let memory_summary: string | null = null;
  const memoryPath = join(projectRoot, "PROJECT_MEMORY.md");
  if (existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, "utf-8");
    const nextMatch = content.match(/## NEXT[\s\S]*?(?=## |$)/);
    if (nextMatch) {
      memory_summary = nextMatch[0].trim().slice(0, 500);
    }
  }

  // If no STATE.json, return a minimal status with framework detection
  if (!framework.has_state) {
    // Try to infer project name from package.json or directory name
    let project = "(not initialized)";
    const pkgPath = join(projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        project = pkg.name ?? project;
      } catch { /* ignore */ }
    }

    return {
      project,
      task_type: "unknown",
      story: null,
      step: "none",
      status: "not_initialized",
      attempt: 0,
      max_attempts: 0,
      reason: null,
      tests: null,
      lint_pass: null,
      files_changed: [],
      blocked_by: [],
      human_note: null,
      memory_summary,
      has_framework: framework,
    };
  }

  // Framework project: read full state
  const state = readState(projectRoot);

  return {
    project: state.project,
    task_type: state.task_type,
    story: state.story,
    step: state.step,
    status: state.status,
    attempt: state.attempt,
    max_attempts: state.max_attempts,
    reason: state.reason,
    tests: state.tests,
    lint_pass: state.lint_pass,
    files_changed: state.files_changed,
    blocked_by: state.blocked_by,
    human_note: state.human_note,
    memory_summary,
    has_framework: framework,
  };
}

/** Project entry returned by listProjects */
export interface ProjectEntry {
  /** Project name (from STATE.json, package.json, or directory name) */
  name: string;
  /** Directory name relative to workspace root */
  dir: string;
  /** Current step ("none" if not using framework) */
  step: string;
  /** Current status ("not_initialized" if not using framework) */
  status: string;
  /** Current story ID */
  story: string | null;
  /** Whether this project uses the Agentic Coding Framework */
  has_framework: boolean;
}

/**
 * Scan a workspace directory for all projects — both framework and non-framework.
 * OpenClaw calls this when the user asks "list my projects" or "switch project".
 *
 * A directory is considered a "project" if it contains any of:
 * - .ai/STATE.json (framework project)
 * - package.json (Node.js project)
 * - go.mod (Go project)
 * - Cargo.toml (Rust project)
 * - pyproject.toml or setup.py (Python project)
 * - .git/ (any git repo)
 */
export function listProjects(workspaceRoot: string): ProjectEntry[] {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const results: ProjectEntry[] = [];

  const PROJECT_MARKERS = [
    ".ai/STATE.json",
    "package.json",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "setup.py",
    ".git",
  ];

  let entries: string[];
  try {
    entries = readdirSync(workspaceRoot);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden directories (except .git check is internal)
    if (entry.startsWith(".")) continue;

    const dir = join(workspaceRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;

      // Check if this directory is a project
      const isProject = PROJECT_MARKERS.some((marker) =>
        existsSync(join(dir, marker))
      );
      if (!isProject) continue;

      const stateFile = join(dir, ".ai", "STATE.json");
      const hasFramework = existsSync(stateFile);

      if (hasFramework) {
        // Framework project: read state
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as State;
        results.push({
          name: state.project,
          dir: entry,
          step: state.step,
          status: state.status,
          story: state.story,
          has_framework: true,
        });
      } else {
        // Non-framework project: infer name from package.json or dir name
        let name = entry;
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            name = pkg.name ?? entry;
          } catch { /* ignore */ }
        }
        results.push({
          name,
          dir: entry,
          step: "none",
          status: "not_initialized",
          story: null,
          has_framework: false,
        });
      }
    } catch {
      // skip unreadable directories
    }
  }

  return results;
}

// ─── Start Custom Task ──────────────────────────────────────────────────────

/**
 * Begin a custom (ad-hoc) task. The orchestrator forwards the instruction
 * to Claude Code with full project context, without going through the
 * micro-waterfall pipeline.
 *
 * Pipeline: custom → update-memory → done
 * Auto-initializes STATE.json if the project hasn't adopted the framework yet.
 *
 * Use cases: refactoring, code review, bug fix, DevOps, documentation,
 * testing, migration, performance optimization, security, cleanup, etc.
 */
export function startCustom(
  projectRoot: string,
  instruction: string,
  label?: string
): State {
  const state = ensureState(projectRoot);
  const rule = getRule("custom");

  state.story = label ?? `CUSTOM-${Date.now()}`;
  state.step = "custom";
  state.attempt = 1;
  state.max_attempts = rule.max_attempts;
  state.status = "pending";
  state.reason = null;
  state.dispatched_at = null;
  state.completed_at = null;
  state.timeout_min = rule.timeout_min;
  state.tests = null;
  state.failing_tests = [];
  state.lint_pass = null;
  state.files_changed = [];
  state.blocked_by = [];
  state.human_note = instruction;
  state.task_type = "custom";

  writeState(projectRoot, state);
  return state;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function elapsedMinutes(isoTimestamp: string): number {
  return Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 60_000);
}

function formatReviewRequest(state: State): string {
  const storyId = state.story ?? "(no story)";
  return (
    `Story ${storyId} is ready for review.\n` +
    `Please check:\n` +
    `- docs/bdd/${storyId}.md (BDD scenarios)\n` +
    `- docs/deltas/${storyId}.md (Delta Spec)\n` +
    `- docs/api/openapi.yaml (contract changes)\n\n` +
    `Reply "approved" to continue, or provide feedback.`
  );
}
