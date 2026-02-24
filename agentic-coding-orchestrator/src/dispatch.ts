/**
 * dispatch.ts — Orchestrator State Machine + Prompt Builder + Handoff Parser
 *
 * The only file with logic. Combines state.ts (read/write) and rules.ts (lookup)
 * to drive the micro-waterfall pipeline. All decisions are deterministic —
 * zero LLM tokens.
 *
 * Main entry points:
 *   dispatch(projectRoot)  — dispatch next step (mutates STATE)
 *   peek(projectRoot)      — [FIX P1] read-only dispatch preview (no mutation)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  readState,
  writeState,
  initState,
  isTimedOut,
  isMaxedOut,
  markRunning,
  State,
} from "./state";
import {
  getRule,
  resolvePaths,
  getFailTarget,
  StepRule,
} from "./rules";

// ─── Dispatch Result Types ──────────────────────────────────────────────────

export type DispatchResult =
  | { type: "dispatched"; step: string; attempt: number; prompt: string; fw_lv: number }
  | { type: "done"; story: string; summary: string }
  | { type: "needs_human"; step: string; message: string }
  | { type: "blocked"; step: string; reason: string }
  | { type: "already_running"; step: string; elapsed_min: number }
  | { type: "timeout"; step: string; elapsed_min: number };

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
  return _dispatch(projectRoot, false);
}

/**
 * [FIX P1] Read-only dispatch preview — returns the same DispatchResult
 * as dispatch() but never writes to STATE.json.
 *
 * Use cases:
 *   - dispatch-claude-code.sh: check if dispatch would succeed before committing
 *   - Monitoring / debugging without state contamination
 *   - OpenClaw dry-run checks
 */
export function peek(projectRoot: string): DispatchResult {
  return _dispatch(projectRoot, true);
}

/** Internal dispatch implementation with optional dry-run mode */
function _dispatch(projectRoot: string, dryRun: boolean): DispatchResult {
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
      if (!dryRun) {
        state.status = "timeout";
        state.completed_at = new Date().toISOString();
        writeState(projectRoot, state);
      }
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
    if (state.status !== "needs_human" && !dryRun) {
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
      if (!dryRun) writeState(projectRoot, state);
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
      if (!dryRun) writeState(projectRoot, state);
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
      if (!dryRun) writeState(projectRoot, state);
      return {
        type: "blocked",
        step: state.step,
        reason:
          `Max attempts (${state.max_attempts}) exhausted at step "${state.step}". ` +
          (state.reason
            ? `Last reason: ${state.reason}`
            : "No specific reason."),
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

  if (!dryRun) {
    const running = markRunning(state);
    writeState(projectRoot, running);
  }

  // Detect framework adoption level so caller knows the context richness
  const framework = detectFramework(projectRoot);

  return {
    type: "dispatched",
    step: state.step,
    attempt: state.attempt,
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
  lines.push(
    `You are executing step "${rule.display_name}" for ${storyId}.`,
  );
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
    lines.push(
      `- Pass: ${state.tests.pass}, Fail: ${state.tests.fail}, Skip: ${state.tests.skip}`,
    );
    if (state.files_changed.length > 0) {
      lines.push(`- Files changed: ${state.files_changed.join(", ")}`);
    }
    lines.push("");
  }

  // Agent-teams
  if (state.agent_teams) {
    lines.push("=== Agent Teams ===");
    lines.push(
      "You may spawn sub-agents using Claude Code's agent-teams feature to parallelize this work. " +
        "Assign sub-agents by role (e.g. backend, frontend, test) with scoped context. " +
        "Each sub-agent should produce its own HANDOFF.md or result summary for you to merge.",
    );
    lines.push("===================");
    lines.push("");
  }

  // === PRIMARY TASK (this is the actual work CC must do) ===
  lines.push("=== YOUR PRIMARY TASK ===");
  lines.push(rule.step_instruction);
  lines.push("");
  lines.push(
    "Focus on completing the task above FIRST. Modify source files, create",
  );
  lines.push(
    "tests, update documents — whatever the task requires. Do NOT stop after",
  );
  lines.push(
    "just updating .ai/HANDOFF.md — that is only the final bookkeeping step.",
  );
  lines.push("=========================");
  lines.push("");

  // === POST-TASK BOOKKEEPING (only after the real work is done) ===
  lines.push(
    "After you have completed ALL the work above, do this final bookkeeping:",
  );
  lines.push(
    "- Only modify affected files and paragraphs, don't rewrite unrelated content",
  );
  lines.push("- Update .ai/HANDOFF.md as a summary of what you did:");
  lines.push(
    "  - YAML front matter: fill in story, step, attempt, status, reason, files_changed, tests values",
  );
  lines.push(
    "  - Markdown body: record what was done, what's unresolved, what next session should note",
  );
  lines.push(
    "- If requirements unclear, set status: failing and reason: needs_clarification",
  );
  lines.push(
    "- If Constitution violation found, set status: failing and reason: constitution_violation",
  );
  lines.push(
    "- If touching Non-Goals scope, set status: failing and reason: scope_warning",
  );

  return lines.join("\n");
}

// ─── Handoff Parser ──────────────────────────────────────────────────────────

export interface HandoffData {
  story: string | null;
  step: string | null;
  attempt: number | null;
  status: string | null;
  reason: string | null;
  files_changed: string[];
  tests_pass: number | null;
  tests_fail: number | null;
  tests_skip: number | null;
  body: string;
}

/**
 * Parse HANDOFF.md — prioritize YAML front matter, fallback to grep.
 * Direct translation of Protocol's hook pseudocode.
 */
export function parseHandoff(projectRoot: string): HandoffData | null {
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
function parseYamlFrontMatter(content: string): HandoffData {
  const parts = content.split("---");
  // parts[0] = "" (before first ---), parts[1] = YAML, parts[2+] = body
  const yamlBlock = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();

  const yaml = parseSimpleYaml(yamlBlock);

  return {
    story: yaml["story"] ?? null,
    step: yaml["step"] ?? null,
    attempt: yaml["attempt"] ? parseInt(yaml["attempt"], 10) : null,
    status: yaml["status"] ?? null,
    reason: (yaml["reason"] as string) || null,
    files_changed: parseYamlList(yaml["files_changed"]),
    tests_pass: yaml["tests_pass"]
      ? parseInt(yaml["tests_pass"], 10)
      : null,
    tests_fail: yaml["tests_fail"]
      ? parseInt(yaml["tests_fail"], 10)
      : null,
    tests_skip: yaml["tests_skip"]
      ? parseInt(yaml["tests_skip"], 10)
      : null,
    body,
  };
}

/** Fallback parser: grep for reason keywords in markdown body */
function parseFallback(content: string): HandoffData {
  const reasonMap: Record<string, string> = {
    "NEEDS CLARIFICATION": "needs_clarification",
    "CONSTITUTION VIOLATION": "constitution_violation",
    "SCOPE WARNING": "scope_warning",
  };

  let reason: string | null = null;
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
 *
 * [FIX P2] Improved to handle:
 *   - Inline bracket lists: `files: [a.go, b.ts]`
 *   - Values containing colons: `reason: needs_clarification: details here`
 *     (only first colon splits key/value, rest is part of the value)
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

    // Key: value pair — use FIRST colon only, rest is value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      currentKey = key;

      if (value) {
        // [FIX P2] Handle inline bracket lists: `files: [a.go, b.ts]`
        if (value.startsWith("[") && value.endsWith("]")) {
          const inner = value.slice(1, -1);
          const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
          result[key] = JSON.stringify(items);
          currentKey = null;
        } else {
          // "null" → empty
          result[key] = value === "null" ? "" : value;
          currentKey = null; // not expecting list items
        }
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
  execSync: (cmd: string, opts: object) => Buffer,
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
  humanNote?: string,
): void {
  const state = readState(projectRoot);
  if (state.step !== "review") {
    throw new Error(
      `Cannot approve review: current step is "${state.step}", not "review"`,
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
  reason: string,
  humanNote?: string,
): void {
  const state = readState(projectRoot);
  if (state.step !== "review") {
    throw new Error(
      `Cannot reject review: current step is "${state.step}", not "review"`,
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
 */
function ensureState(projectRoot: string): State {
  const path = join(projectRoot, ".ai", "STATE.json");
  if (existsSync(path)) {
    return readState(projectRoot);
  }

  // Infer project name
  let projectName =
    projectRoot.split("/").filter(Boolean).pop() ?? "project";

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) projectName = pkg.name;
    } catch {
      /* ignore */
    }
  }

  const goModPath = join(projectRoot, "go.mod");
  if (existsSync(goModPath)) {
    try {
      const goMod = readFileSync(goModPath, "utf-8");
      const moduleLine = goMod
        .split("\n")
        .find((l: string) => l.startsWith("module "));
      if (moduleLine) {
        const parts = moduleLine.replace("module ", "").trim().split("/");
        projectName = parts[parts.length - 1] ?? projectName;
      }
    } catch {
      /* ignore */
    }
  }

  const { state } = initState(projectRoot, projectName);
  return state;
}

// ─── Start New Story ─────────────────────────────────────────────────────────

/**
 * Begin a new User Story. Resets state to bdd step with attempt 1.
 * Auto-initializes STATE.json if the project hasn't adopted the framework yet.
 */
export function startStory(
  projectRoot: string,
  storyId: string,
  options: { agentTeams?: boolean } = {},
): State {
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
  state.agent_teams = options.agentTeams ?? false;

  writeState(projectRoot, state);
  return state;
}

/**
 * Detect whether a project uses the Agentic Coding Framework.
 * OpenClaw calls this when the user asks "is this project using the framework?"
 */
export function detectFramework(projectRoot: string): {
  has_state: boolean;
  has_memory: boolean;
  has_context: boolean;
  has_constitution: boolean;
  has_sdd: boolean;
  has_handoff: boolean;
  has_history: boolean;
  level: number;
} {
  const check = (p: string) => existsSync(join(projectRoot, p));
  const has_state = check(".ai/STATE.json");
  const has_memory = check("PROJECT_MEMORY.md");
  const has_context = check("PROJECT_CONTEXT.md");
  const has_constitution = check("docs/constitution.md");
  const has_sdd = check("docs/sdd.md");
  const has_handoff = check(".ai/HANDOFF.md");
  const has_history = check(".ai/history.md");

  const core = [
    has_state,
    has_memory,
    has_context,
    has_constitution,
    has_sdd,
  ];
  const coreCount = core.filter(Boolean).length;

  let level = 0;
  if (coreCount === core.length) level = 2;
  else if (coreCount > 0) level = 1;

  return {
    has_state,
    has_memory,
    has_context,
    has_constitution,
    has_sdd,
    has_handoff,
    has_history,
    level,
  };
}

/**
 * Get comprehensive project status for OpenClaw to summarize to the user.
 */
export function queryProjectStatus(projectRoot: string): Record<string, unknown> {
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

  if (!framework.has_state) {
    let project = "(not initialized)";
    const pkgPath = join(projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        project = pkg.name ?? project;
      } catch {
        /* ignore */
      }
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

/**
 * Scan a workspace directory for all projects.
 */
export function listProjects(workspaceRoot: string): Record<string, unknown>[] {
  const { readdirSync, statSync } = require("fs");
  const results: Record<string, unknown>[] = [];

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
    if (entry.startsWith(".")) continue;
    const dir = join(workspaceRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const isProject = PROJECT_MARKERS.some((marker: string) =>
        existsSync(join(dir, marker)),
      );
      if (!isProject) continue;

      const stateFile = join(dir, ".ai", "STATE.json");
      const hasFramework = existsSync(stateFile);

      if (hasFramework) {
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        results.push({
          name: state.project,
          dir: entry,
          step: state.step,
          status: state.status,
          story: state.story,
          has_framework: true,
        });
      } else {
        let name = entry;
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            name = pkg.name ?? entry;
          } catch {
            /* ignore */
          }
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
 */
export function startCustom(
  projectRoot: string,
  instruction: string,
  options: { label?: string; agentTeams?: boolean } = {},
): State {
  const state = ensureState(projectRoot);
  const rule = getRule("custom");

  state.story = options.label ?? `CUSTOM-${Date.now()}`;
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
  state.agent_teams = options.agentTeams ?? false;

  writeState(projectRoot, state);
  return state;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function elapsedMinutes(isoTimestamp: string): number {
  return Math.round(
    (Date.now() - new Date(isoTimestamp).getTime()) / 60_000,
  );
}

/**
 * [FIX P2] Use resolvePaths() for review request paths to stay consistent
 * with the path resolution logic (prevents stale paths if format changes).
 */
function formatReviewRequest(state: State): string {
  const storyId = state.story ?? "(no story)";
  const paths = resolvePaths(
    [
      "docs/bdd/US-{story}.md",
      "docs/deltas/US-{story}.md",
    ],
    storyId,
  );

  return (
    `Story ${storyId} is ready for review.\n` +
    `Please check:\n` +
    `- ${paths[0]} (BDD scenarios)\n` +
    `- ${paths[1]} (Delta Spec)\n` +
    `- docs/api/openapi.yaml (contract changes)\n\n` +
    `Reply "approved" to continue, or provide feedback.`
  );
}
