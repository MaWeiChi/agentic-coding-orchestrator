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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  readState,
  writeState,
  initState,
  isTimedOut,
  isMaxedOut,
  markRunning,
  sanitize,
  appendLog,
  State,
} from "./state";
import {
  getRule,
  resolvePaths,
  getFailTarget,
  getStepSequence,
  StepRule,
  DEFAULT_TEAM_ROLES,
} from "./rules";

// ─── Result Types ────────────────────────────────────────────────────────────

export type DispatchResult =
  | { type: "dispatched"; project: string | null; story: string | null; step: string; attempt: number; prompt: string; fw_lv: number }
  | { type: "done"; story: string; summary: string }
  | { type: "needs_human"; step: string; message: string }
  | { type: "blocked"; step: string; reason: string }
  | { type: "already_running"; step: string; elapsed_min: number; last_error: string | null }
  | { type: "timeout"; step: string; elapsed_min: number; last_error: string | null }
  | { type: "error"; code: string; message: string; step?: string; recoverable: boolean };

export type HandoffResult =
  | { type: "applied"; state: State }
  | { type: "stale"; state: State; message: string }
  | { type: "missing"; state: State; message: string }
  | { type: "error"; code: string; message: string; state?: State; recoverable: boolean };

export type ActionResult =
  | { type: "ok"; state: State; message: string }
  | { type: "error"; code: string; message: string; recoverable: boolean };

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
  let state: State;
  try {
    state = readState(projectRoot);
  } catch (err) {
    appendLog(projectRoot, "ERROR", "dispatch", `STATE_NOT_FOUND: ${(err as Error).message}`);
    return {
      type: "error",
      code: "STATE_NOT_FOUND",
      message: (err as Error).message,
      recoverable: false,
    };
  }

  try {
    return _dispatchInner(projectRoot, state, dryRun);
  } catch (err) {
    // Catch-all: record error in state and return structured result
    const msg = (err as Error).message;
    state.last_error = `[dispatch] ${msg}`;
    try { writeState(projectRoot, state); } catch { /* best effort */ }
    appendLog(projectRoot, "CRITICAL", "dispatch", `INTERNAL_ERROR at step "${state.step}": ${msg}`);
    return {
      type: "error",
      code: "INTERNAL_ERROR",
      message: msg,
      step: state.step,
      recoverable: true,
    };
  }
}

/** Core dispatch logic, separated so _dispatch can catch all errors */
function _dispatchInner(projectRoot: string, state: State, dryRun: boolean): DispatchResult {
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
      const elapsed = elapsedMinutes(state.dispatched_at!);
      if (!dryRun) {
        state.status = "timeout";
        state.completed_at = new Date().toISOString();
        state.last_error = `Step "${state.step}" timed out after ${elapsed.toFixed(1)} min (limit: ${state.timeout_min} min)`;
        writeState(projectRoot, state);
        appendLog(projectRoot, "TIMEOUT", "dispatch", `Step "${state.step}" timed out after ${elapsed.toFixed(1)}min (limit: ${state.timeout_min}min)`);
      }
      return {
        type: "timeout",
        step: state.step,
        elapsed_min: elapsed,
        last_error: state.last_error,
      };
    }
    // Still running
    return {
      type: "already_running",
      step: state.step,
      elapsed_min: elapsedMinutes(state.dispatched_at!),
      last_error: state.last_error,
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

  // ── Scaffold semantic: "failing" = expected RED stubs = treat as pass ──
  if (
    state.status === "failing" &&
    rule.treat_failing_as_pass &&
    !state.reason // only when no error reason (pure RED test output)
  ) {
    state.status = "pass";
  }

  // ── Success → advance to next step ──
  if (state.status === "pass") {
    state.step = rule.next_on_pass;
    state.attempt = 1;
    state.status = "pending";
    state.reason = null;
    state.human_note = null;
    state.last_error = null;
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
      if (!dryRun) {
        writeState(projectRoot, state);
        appendLog(projectRoot, "WARN", "dispatch", `Max attempts (${state.max_attempts}) exhausted at step "${state.step}"${state.reason ? ` reason: ${state.reason}` : ""}`);
      }
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

  // ── Pre-dispatch prerequisite check ──
  const prereq = checkPrerequisites(projectRoot);

  // ── Dispatch executor ──
  const currentRule = getRule(state.step);
  let prompt = buildPrompt(state, currentRule);

  // Append prerequisite warnings to prompt if files missing
  if (!prereq.ok) {
    const lines: string[] = [];
    lines.push("=== WARNING: MISSING PREREQUISITE FILES ===");
    for (const w of prereq.warnings) {
      lines.push(`- ${w}`);
    }
    if (prereq.suggested_rollback) {
      lines.push(
        `Suggested action: orchestrator rollback ${prereq.suggested_rollback}`,
      );
    }
    lines.push("You may need to produce these files as part of your work,");
    lines.push("or alert the human if they should have been created in a prior step.");
    lines.push("=============================================");
    lines.push("");
    prompt = prompt + "\n" + lines.join("\n");
  }

  if (!dryRun) {
    const running = markRunning(state);
    writeState(projectRoot, running);
  }

  // Detect framework adoption level so caller knows the context richness
  const framework = detectFramework(projectRoot);

  return {
    type: "dispatched",
    project: state.project,
    story: state.story,
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
    const teamRoles = DEFAULT_TEAM_ROLES[state.step];
    if (teamRoles) {
      // Structured Agent Teams: spawn teammates with specific roles
      lines.push("=== AGENT TEAMS — PARALLEL EXECUTION ===");
      lines.push(
        "You are the TEAM LEAD. Create an agent team to parallelize this step. " +
          "Spawn the following teammates, each with their scoped responsibility:",
      );
      lines.push("");

      const storyId = state.story ?? "unknown";
      for (const [roleName, role] of Object.entries(teamRoles)) {
        const reads = resolvePaths(role.claude_reads, storyId).join(", ");
        const writes = role.claude_writes.join(", ");
        lines.push(`### Teammate: ${roleName}`);
        lines.push(`- Reads: ${reads}`);
        lines.push(`- Writes: ${writes}`);
        lines.push(
          `- Spawn prompt: "You are the ${roleName} agent for story ${storyId}. ` +
            `Your job is to implement the ${roleName} portion of this story. ` +
            `Read these files for context: ${reads}. ` +
            `You may ONLY modify files matching: ${writes}. ` +
            `Do NOT touch files outside your scope. ` +
            `When done, send a message to the team lead with a summary of changes."`,
        );
        lines.push("");
      }

      lines.push("TEAM LEAD INSTRUCTIONS:");
      lines.push(
        "1. Spawn all teammates listed above using agent teams (NOT subagents).",
      );
      lines.push(
        "2. Wait for ALL teammates to complete before proceeding.",
      );
      lines.push(
        "3. Review each teammate's results. If any teammate failed, report failing in HANDOFF.md.",
      );
      lines.push(
        "4. Merge all results into a single HANDOFF.md summarizing the combined work.",
      );
      lines.push(
        "5. Do NOT start implementing yourself — delegate to teammates.",
      );
      lines.push("==========================================");
      lines.push("");
    } else {
      // Generic agent teams hint for steps without defined roles
      lines.push("=== Agent Teams ===");
      lines.push(
        "You may spawn sub-agents using Claude Code's agent-teams feature to parallelize this work. " +
          "Assign sub-agents by role with scoped context. " +
          "Each sub-agent should produce its own result summary for you to merge.",
      );
      lines.push("===================");
      lines.push("");
    }
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

  // === STEP BOUNDARY (prevent CC from doing multiple steps) ===
  lines.push("=== STEP BOUNDARY — READ CAREFULLY ===");
  lines.push(
    `Your scope is ONLY the "${rule.display_name}" step. Do NOT proceed to the next step.`,
  );
  if (rule.next_on_pass && rule.next_on_pass !== "done") {
    lines.push(
      `After this step, the orchestrator will advance to "${rule.next_on_pass}" — that is NOT your job.`,
    );
  }
  lines.push(
    "When your current step is complete, write HANDOFF.md and STOP. " +
      "Do not continue working on subsequent steps even if you know what they are.",
  );
  lines.push("======================================");
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
  lines.push("");

  // Checklist update instruction
  lines.push("=== CHECKLIST UPDATE ===");
  lines.push(
    "After completing your work for this step, update .ai/CHECKLIST.md:",
  );
  lines.push(
    "- Check off (replace [ ] with [x]) all items relevant to this step that you have completed.",
  );
  lines.push(
    "- Do NOT check off items for future steps — only mark what you actually did.",
  );
  lines.push("========================");

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
 *
 * Returns a structured HandoffResult so the caller (hook, LLM, CLI) can
 * see exactly what happened — never throws.
 */
export function applyHandoff(projectRoot: string): HandoffResult {
  let state: State;
  try {
    state = readState(projectRoot);
  } catch (err) {
    appendLog(projectRoot, "ERROR", "applyHandoff", `STATE_NOT_FOUND: ${(err as Error).message}`);
    return {
      type: "error",
      code: "STATE_NOT_FOUND",
      message: (err as Error).message,
      recoverable: false,
    };
  }

  const handoff = parseHandoff(projectRoot);

  if (!handoff) {
    // No HANDOFF.md — executor might have crashed
    state.status = "failing";
    state.reason = null;
    state.completed_at = new Date().toISOString();
    state.last_error = `No HANDOFF.md found after executor completed step "${state.step}". Executor may have crashed or exceeded token limits.`;
    try { writeState(projectRoot, state); } catch { /* best effort */ }
    appendLog(projectRoot, "WARN", "applyHandoff", `No HANDOFF.md found after step "${state.step}" — executor may have crashed`);
    return {
      type: "missing",
      state,
      message: state.last_error,
    };
  }

  // [FIX P0] Stale HANDOFF guard: if HANDOFF.step doesn't match STATE.step,
  // this HANDOFF is from a previous step (e.g., hook re-fires after dispatch
  // already advanced). Applying it would overwrite the current step's status
  // with stale data, potentially skipping steps entirely.
  if (handoff.step && handoff.step !== state.step) {
    appendLog(projectRoot, "WARN", "applyHandoff", `Stale HANDOFF ignored: step "${handoff.step}" != state step "${state.step}"`);
    return {
      type: "stale",
      state,
      message: `HANDOFF step "${handoff.step}" does not match STATE step "${state.step}". Stale HANDOFF ignored.`,
    };
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

  // [FIX P0] Sanitize before write — HANDOFF status may be "done"/"complete"
  // (CC agent lifecycle status leaking into ACO status field).
  // Without this, writeState → validate() throws and the pipeline stalls.
  sanitize(state, projectRoot);

  try {
    writeState(projectRoot, state);
  } catch (err) {
    state.last_error = `[applyHandoff] Failed to write STATE after applying HANDOFF: ${(err as Error).message}`;
    appendLog(projectRoot, "CRITICAL", "applyHandoff", `STATE_CORRUPTION: ${state.last_error}`);
    return {
      type: "error",
      code: "STATE_CORRUPTION",
      message: state.last_error,
      state,
      recoverable: true,
    };
  }

  appendLog(projectRoot, "INFO", "applyHandoff", `Applied HANDOFF: step="${state.step}" status="${state.status}"${state.tests ? ` tests=${state.tests.pass}/${state.tests.fail}/${state.tests.skip}` : ""}`);
  return { type: "applied", state };
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
): ActionResult {
  let state: State;
  try { state = readState(projectRoot); } catch (err) {
    return { type: "error", code: "STATE_NOT_FOUND", message: (err as Error).message, recoverable: false };
  }
  if (state.step !== "review") {
    appendLog(projectRoot, "ERROR", "approve", `WRONG_STEP: current step is "${state.step}", not "review"`);
    return {
      type: "error",
      code: "WRONG_STEP",
      message: `Cannot approve review: current step is "${state.step}", not "review"`,
      recoverable: false,
    };
  }
  state.status = "pass";
  state.human_note = humanNote ?? null;
  writeState(projectRoot, state);
  appendLog(projectRoot, "INFO", "approve", `Review approved for story "${state.story}"${humanNote ? ` note: "${humanNote}"` : ""}`);
  return { type: "ok", state, message: `Review approved${humanNote ? ` (note: "${humanNote}")` : ""}` };
}

/**
 * Reject the review with a reason and optional note.
 */
export function rejectReview(
  projectRoot: string,
  reason: string,
  humanNote?: string,
): ActionResult {
  let state: State;
  try { state = readState(projectRoot); } catch (err) {
    return { type: "error", code: "STATE_NOT_FOUND", message: (err as Error).message, recoverable: false };
  }
  if (state.step !== "review") {
    appendLog(projectRoot, "ERROR", "reject", `WRONG_STEP: current step is "${state.step}", not "review"`);
    return {
      type: "error",
      code: "WRONG_STEP",
      message: `Cannot reject review: current step is "${state.step}", not "review"`,
      recoverable: false,
    };
  }
  state.status = "failing";
  state.reason = reason;
  state.human_note = humanNote ?? null;
  writeState(projectRoot, state);
  appendLog(projectRoot, "INFO", "reject", `Review rejected for story "${state.story}" reason: ${reason}`);
  return { type: "ok", state, message: `Review rejected (reason: ${reason})` };
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
  options: { agentTeams?: boolean; force?: boolean } = {},
): ActionResult {
  let state: State;
  try {
    state = ensureState(projectRoot);
  } catch (err) {
    return { type: "error", code: "STATE_NOT_FOUND", message: (err as Error).message, recoverable: false };
  }

  // Guard: prevent restarting a completed story
  if (state.story === storyId && state.step === "done" && !options.force) {
    appendLog(projectRoot, "WARN", "startStory", `Story ${storyId} already completed (step: done)`);
    return {
      type: "error",
      code: "ALREADY_COMPLETED",
      message: `Story ${storyId} is already completed (step: "done"). Use --force to restart it, or start a different story.`,
      recoverable: false,
    };
  }

  // Guard: prevent restarting a story that is currently running
  if (state.story === storyId && state.status === "running" && !options.force) {
    appendLog(projectRoot, "WARN", "startStory", `Story ${storyId} already running (step: ${state.step})`);
    return {
      type: "error",
      code: "ALREADY_RUNNING",
      message: `Story ${storyId} is currently running (step: "${state.step}"). Wait for it to finish or use --force to override.`,
      recoverable: false,
    };
  }

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
  state.last_error = null;
  state.agent_teams = options.agentTeams ?? false;

  writeState(projectRoot, state);

  // Auto-generate per-story checklist
  generateChecklist(projectRoot, storyId);

  appendLog(projectRoot, "INFO", "startStory", `Started story ${storyId} at bdd step`);
  return { type: "ok", state, message: `Started story ${storyId} at bdd step` };
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

  // Resolve next_step so the caller knows the pipeline trajectory
  let next_step: string | null = null;
  try {
    if (state.step !== "done") {
      const rule = getRule(state.step);
      next_step = rule.next_on_pass;
    }
  } catch {
    // unknown step — leave null
  }

  return {
    project: state.project,
    task_type: state.task_type,
    story: state.story,
    step: state.step,
    next_step,
    status: state.status,
    attempt: state.attempt,
    max_attempts: state.max_attempts,
    reason: state.reason,
    tests: state.tests,
    lint_pass: state.lint_pass,
    files_changed: state.files_changed,
    blocked_by: state.blocked_by,
    human_note: state.human_note,
    last_error: state.last_error,
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
): ActionResult {
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
  state.last_error = null;
  state.task_type = "custom";
  state.agent_teams = options.agentTeams ?? false;

  writeState(projectRoot, state);
  appendLog(projectRoot, "INFO", "startCustom", `Custom task "${state.story}" started: "${instruction}"`);
  return { type: "ok", state, message: `Custom task '${state.story}' started` };
}

// ─── Rollback ────────────────────────────────────────────────────────────────

/**
 * Roll back to a previous step in the pipeline.
 * Validates the target is a valid step before the current position.
 * Resets status to "pending", attempt to 1, clears error state.
 */
export function rollback(
  projectRoot: string,
  targetStep: string,
  options: { force?: boolean } = {},
): ActionResult {
  let state: State;
  try {
    state = readState(projectRoot);
  } catch (err) {
    return { type: "error", code: "STATE_NOT_FOUND", message: (err as Error).message, recoverable: false };
  }

  const sequence = getStepSequence();

  // Validate target step exists in sequence (or is "bootstrap")
  const targetIndex = targetStep === "bootstrap" ? -1 : sequence.indexOf(targetStep);
  const currentIndex = state.step === "bootstrap" ? -1 : sequence.indexOf(state.step);

  if (targetStep !== "bootstrap" && targetIndex === -1) {
    appendLog(projectRoot, "ERROR", "rollback", `INVALID_TARGET: "${targetStep}"`);
    return {
      type: "error",
      code: "INVALID_TARGET",
      message: `Invalid rollback target "${targetStep}". Valid steps: bootstrap, ${sequence.join(", ")}`,
      recoverable: false,
    };
  }

  // Prevent rollback to bootstrap unless --force
  if (targetStep === "bootstrap" && !options.force) {
    appendLog(projectRoot, "ERROR", "rollback", `BOOTSTRAP_NEEDS_FORCE: rollback to bootstrap without --force`);
    return {
      type: "error",
      code: "BOOTSTRAP_NEEDS_FORCE",
      message: `Cannot rollback to "bootstrap" — it is a one-time initialization step. Use --force to override.`,
      recoverable: false,
    };
  }

  // Prevent rollback to current or later step
  if (targetIndex >= currentIndex && state.step !== "done") {
    appendLog(projectRoot, "ERROR", "rollback", `ROLLBACK_FORWARD: "${targetStep}" is at/after current step "${state.step}"`);
    return {
      type: "error",
      code: "ROLLBACK_FORWARD",
      message: `Cannot rollback to "${targetStep}" — it is at or after the current step "${state.step}". Rollback must target an earlier step.`,
      recoverable: false,
    };
  }

  // Reset state
  const previousStep = state.step;
  const rule = targetStep === "bootstrap"
    ? getRule("bootstrap")
    : getRule(targetStep);

  state.step = targetStep;
  state.status = "pending";
  state.attempt = 1;
  state.max_attempts = rule.max_attempts;
  state.timeout_min = rule.timeout_min;
  state.reason = null;
  state.last_error = null;
  state.files_changed = [];
  state.dispatched_at = null;
  state.completed_at = null;
  // [FIX P1] Clear stale test data — without this, old test results
  // from a later step carry over and pollute the rollback target step.
  state.tests = null;
  state.failing_tests = [];
  state.lint_pass = null;

  writeState(projectRoot, state);
  appendLog(projectRoot, "INFO", "rollback", `Rolled back from "${previousStep}" to "${targetStep}"`);
  return {
    type: "ok",
    state,
    message: `Rolled back to "${targetStep}" (attempt 1, status: pending)`,
  };
}

// ─── Pre-Dispatch Prerequisite Check ─────────────────────────────────────────

export interface PrereqCheckResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
  suggested_rollback: string | null;
}

/**
 * Check if prerequisite files (claude_reads) exist before dispatching.
 * Only checks concrete paths (skips wildcards like *.go, **\/*.ts).
 * Returns warnings — does not block dispatch.
 */
export function checkPrerequisites(projectRoot: string): PrereqCheckResult {
  const state = readState(projectRoot);

  if (state.step === "done") {
    return { ok: true, missing: [], warnings: [], suggested_rollback: null };
  }

  const rule = getRule(state.step);
  const storyId = state.story ?? "unknown";
  const resolvedPaths = resolvePaths(rule.claude_reads, storyId);

  const missing: string[] = [];
  for (const p of resolvedPaths) {
    // Skip wildcards and globs
    if (p.includes("*") || p.includes("?")) continue;
    // Skip HANDOFF.md — it may not exist on first attempt
    if (p.endsWith("HANDOFF.md") && state.attempt === 1) continue;

    const fullPath = join(projectRoot, p);
    if (!existsSync(fullPath)) {
      missing.push(p);
    }
  }

  if (missing.length === 0) {
    return { ok: true, missing: [], warnings: [], suggested_rollback: null };
  }

  // Suggest which step to rollback to based on missing files
  const warnings = missing.map(
    (f) => `Missing prerequisite: ${f}`,
  );

  // Heuristic: suggest rollback based on what's missing
  let suggested_rollback: string | null = null;
  if (missing.some((f) => f.includes("bdd/"))) {
    suggested_rollback = "bdd";
  } else if (missing.some((f) => f.includes("deltas/"))) {
    suggested_rollback = "sdd-delta";
  } else if (missing.some((f) => f.includes("api/"))) {
    suggested_rollback = "contract";
  } else if (missing.some((f) => f.includes("sdd.md"))) {
    suggested_rollback = "bootstrap";
  } else if (missing.some((f) => f.includes("PROJECT_MEMORY"))) {
    suggested_rollback = "bootstrap";
  }

  return {
    ok: false,
    missing,
    warnings,
    suggested_rollback,
  };
}

// ─── Checklist System ────────────────────────────────────────────────────────

/**
 * Generate .ai/CHECKLIST.md for a story. Called by startStory().
 * The checklist is a per-story progress tracker that CC must update
 * as it completes each step.
 */
export function generateChecklist(projectRoot: string, storyId: string): string {
  const checklistPath = join(projectRoot, ".ai", "CHECKLIST.md");
  const aiDir = join(projectRoot, ".ai");
  if (!existsSync(aiDir)) {
    mkdirSync(aiDir, { recursive: true });
  }

  const content = `# Checklist: ${storyId}

> Auto-generated by ACO. Executor MUST check off items as they are completed.

## BDD
- [ ] All scenarios written with Given/When/Then
- [ ] All scenarios tagged with test level (@unit, @integration, @e2e, etc.)
- [ ] Non-Goals section defined
- [ ] Unclear items marked [NEEDS CLARIFICATION]

## SDD Delta
- [ ] Delta Spec produced (ADDED / MODIFIED / REMOVED)
- [ ] Affected modules identified
- [ ] Non-Goals / Out of Scope section included

## API Contract
- [ ] Affected endpoints/events updated in OpenAPI/AsyncAPI
- [ ] Types synchronized with implementation

## Review
- [ ] Human approved BDD + Delta + Contract

## Test Scaffolding
- [ ] All BDD scenarios have corresponding test skeletons
- [ ] All tests fail (RED) — no implementation code yet
- [ ] NFR thresholds referenced from nfr.md

## Implementation
- [ ] All tests pass (GREEN)
- [ ] Only affected files modified (Diff-Only)
- [ ] No unrelated refactoring

## Verify
- [ ] Completeness: all BDD covered, all Delta items implemented
- [ ] Correctness: all tests pass, NFR thresholds met
- [ ] Coherence: SDD merged Delta, contracts consistent, Constitution respected

## Commit
- [ ] Code committed with conventional commit message
- [ ] Story ID included in commit message
- [ ] Commit hash recorded in HANDOFF.md

## Update Memory
- [ ] PROJECT_MEMORY.md updated (NOW/TESTS/NEXT/ISSUES)
- [ ] .ai/history.md appended (DONE + LOG entry)
- [ ] HANDOFF.md overwritten with session summary
`;

  writeFileSync(checklistPath, content, "utf-8");
  return checklistPath;
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
