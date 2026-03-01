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

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "fs";
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
  appendHistory,
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

// ─── Config Constants ────────────────────────────────────────────────────────

/** After N stories reach "done", automatically suggest/trigger a review session */
const REVIEW_TRIGGER_THRESHOLD = 3;

/**
 * Step name alias map — CC executors derive step names from display_name
 * or prompt context, which may not match ACO's internal step identifiers.
 * Applied during applyHandoff() to normalize HANDOFF.step before the
 * stale guard comparison.
 *
 * [FIX P0] Without this, valid HANDOFFs are rejected as "stale" because
 * e.g. "api-contract" !== "contract", causing the pipeline to stall.
 */
const STEP_ALIAS_MAP: Record<string, string> = {
  // contract step aliases
  "api-contract": "contract",
  "api_contract": "contract",
  "contract-update": "contract",
  "api-contract-update": "contract",
  // scaffold step aliases
  "test-scaffolding": "scaffold",
  "test_scaffolding": "scaffold",
  "scaffolding": "scaffold",
  "test-scaffold": "scaffold",
  // sdd-delta aliases
  "sdd_delta": "sdd-delta",
  "sdd": "sdd-delta",
  "delta": "sdd-delta",
  "delta-spec": "sdd-delta",
  // verify aliases
  "quality-gate": "verify",
  "quality_gate": "verify",
  // update-memory aliases
  "update_memory": "update-memory",
  "memory-update": "update-memory",
  // impl aliases
  "implementation": "impl",
  // commit aliases
  "commit-changes": "commit",
};

// ─── Result Types ────────────────────────────────────────────────────────────

export type DispatchResult =
  | { type: "dispatched"; project: string | null; story: string | null; step: string; attempt: number; prompt: string; fw_lv: number }
  | { type: "done"; story: string; summary: string; review_suggested?: boolean }
  | { type: "needs_human"; step: string; message: string }
  | { type: "blocked"; step: string; reason: string }
  | { type: "already_running"; step: string; elapsed_min: number; last_error: string | null }
  | { type: "timeout"; step: string; elapsed_min: number; last_error: string | null }
  | { type: "error"; code: string; message: string; step?: string; recoverable: boolean };

export type HandoffResult =
  | { type: "applied"; state: State }
  | { type: "stale"; state: State; message: string }
  | { type: "pending"; state: State; message: string }
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

  // ── Running state check ──
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
    // Still running — real dispatch returns "already_running",
    // but peek (dryRun) falls through to generate the prompt so
    // dispatch-claude-code.sh can use it after external dispatch.
    if (!dryRun) {
      return {
        type: "already_running",
        step: state.step,
        elapsed_min: elapsedMinutes(state.dispatched_at!),
        last_error: state.last_error,
      };
    }
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
      // Clear reopened_from when story completes
      state.reopened_from = null;

      // Feature 3: Check if review should be triggered
      let review_suggested = false;
      const completedCount = countCompletedStories(projectRoot);
      if (completedCount >= REVIEW_TRIGGER_THRESHOLD) {
        review_suggested = true;
      }

      if (!dryRun) writeState(projectRoot, state);
      const result: any = {
        type: "done",
        story: state.story ?? "(no story)",
        summary: `Story ${state.story} completed. All steps passed.`,
      };
      if (review_suggested) {
        result.review_suggested = true;
      }
      return result;
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

    // Feature 1: Escalation logic for post-reopen verify failures
    // If verify fails after reopen with no explicit reason, escalate by rolling back one step deeper
    let target = getFailTarget(state.step, state.reason);
    if (
      state.step === "verify" &&
      state.reopened_from !== null &&
      state.reason === null  // only escalate for pure RED failure (no specific reason)
    ) {
      // Find the step before reopened_from
      const earlierStep = getEarlierStep(state.reopened_from);
      if (earlierStep !== null) {
        // Escalate to the earlier step (overriding normal routing)
        target = earlierStep;
        if (!dryRun) {
          appendLog(
            projectRoot,
            "INFO",
            "dispatch",
            `Post-reopen verify failure escalation: ${state.step} → ${earlierStep} (was reopened at ${state.reopened_from})`
          );
        }
        // Clear reopened_from so we only escalate once
        state.reopened_from = null;
      }
    }

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

  // Detect framework adoption level so caller knows the context richness
  const framework = detectFramework(projectRoot);

  if (!dryRun) {
    const running = markRunning(state);
    writeState(projectRoot, running);
  }

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
    // [FIX P0] If state is "running", HANDOFF absence means executor hasn't
    // written it yet (e.g. Stop hook fired mid-session, or HANDOFF.md was
    // intentionally cleared before CC launch to prevent stale reads).
    // Only mark "failing" if state is NOT running (executor finished without HANDOFF).
    if (state.status === "running") {
      appendLog(projectRoot, "INFO", "applyHandoff", `No HANDOFF.md found but step "${state.step}" is still running — treating as pending`);
      return {
        type: "pending",
        state,
        message: `No HANDOFF.md found; step "${state.step}" is still running. Executor may not have written it yet.`,
      };
    }
    // Executor finished (state != running) but left no HANDOFF — likely crashed
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

  // [FIX P0] Normalize HANDOFF step name — CC executors may write display-name
  // variants (e.g. "api-contract" instead of "contract", "test-scaffolding"
  // instead of "scaffold"). Without this, valid HANDOFFs are rejected as stale.
  if (handoff.step) {
    const normalized = STEP_ALIAS_MAP[handoff.step.toLowerCase()];
    if (normalized) {
      appendLog(projectRoot, "INFO", "applyHandoff", `Normalized HANDOFF step: "${handoff.step}" → "${normalized}"`);
      handoff.step = normalized;
    }
  }

  // [FIX P0] Timestamp-based stale guard: if HANDOFF.md was last modified BEFORE
  // the current dispatch started, it's from a previous step. This prevents the
  // race condition where Stop/SessionEnd hook fires before CC writes the new HANDOFF.
  // Tolerance: 2 seconds — filesystem mtime granularity + clock skew.
  if (state.dispatched_at) {
    const handoffPath = join(projectRoot, ".ai", "HANDOFF.md");
    try {
      const handoffMtime = statSync(handoffPath).mtimeMs;
      const dispatchedAt = new Date(state.dispatched_at).getTime();
      const TOLERANCE_MS = 2000;
      if (handoffMtime < dispatchedAt - TOLERANCE_MS) {
        const msg = `HANDOFF.md (mtime ${new Date(handoffMtime).toISOString()}) is older than dispatched_at (${state.dispatched_at}). Stale HANDOFF from previous step.`;
        appendLog(projectRoot, "WARN", "applyHandoff", msg);
        return { type: "stale", state, message: msg };
      }
    } catch { /* stat failed, continue to step-name guard */ }
  }

  // [FIX P0] Step-name stale guard (belt and suspenders): if HANDOFF.step doesn't
  // match STATE.step, this HANDOFF is from a previous step.
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

// ─── Helper Functions for Features ────────────────────────────────────────────

/**
 * Count completed stories since last review by reading .ai/history.md
 * and matching entries with reopen pattern.
 */
function countCompletedStories(projectRoot: string): number {
  try {
    const historyPath = join(projectRoot, ".ai", "history.md");
    if (!existsSync(historyPath)) return 0;
    const content = readFileSync(historyPath, "utf-8");
    // Count lines that match "### Reopen" pattern (each represents a completed story that was reopened)
    // Plus we need to count stories that completed naturally
    // For now, count any story-related lines in history
    const matches = content.match(/### Reopen/g) || [];
    return matches.length;
  } catch {
    return 0;
  }
}

/**
 * Find the step that comes before a given step in the sequence.
 * Returns null if the step is the first one (no earlier step).
 */
function getEarlierStep(step: string): string | null {
  const sequence = getStepSequence();
  const index = sequence.indexOf(step);
  if (index <= 0) return null;
  return sequence[index - 1];
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

/**
 * Reopen a completed story at a specified step.
 *
 * Unlike rollback() which moves backwards within an active story,
 * reopen() specifically targets stories that have reached step "done".
 * It resets state to the target step so the pipeline can re-execute from there.
 *
 * Use case: Review Session or triage found issues in a completed US —
 * human decides to reopen it at a specific step (e.g., "impl", "verify").
 *
 * Guards:
 *   - Story must be in "done" state (use rollback for active stories)
 *   - Target step must be a valid pipeline step
 *   - Cannot reopen to "done" (that's a no-op)
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */
export function reopen(
  projectRoot: string,
  targetStep: string,
  options: { humanNote?: string } = {},
): ActionResult {
  let state: State;
  try {
    state = readState(projectRoot);
  } catch (err) {
    return { type: "error", code: "STATE_NOT_FOUND", message: (err as Error).message, recoverable: false };
  }

  // Guard: story must be completed
  if (state.step !== "done") {
    appendLog(projectRoot, "ERROR", "reopen", `NOT_DONE: current step is "${state.step}", not "done". Use rollback instead.`);
    return {
      type: "error",
      code: "NOT_DONE",
      message: `Cannot reopen: story is at step "${state.step}", not "done". Use "rollback" for active stories.`,
      recoverable: false,
    };
  }

  // Cannot reopen to "done" (check before sequence validation since "done" isn't in sequence)
  if (targetStep === "done") {
    return {
      type: "error",
      code: "REOPEN_TO_DONE",
      message: `Cannot reopen to "done" — story is already done.`,
      recoverable: false,
    };
  }

  // Validate target step
  const sequence = getStepSequence();
  const targetIndex = targetStep === "bootstrap" ? -1 : sequence.indexOf(targetStep);

  if (targetStep !== "bootstrap" && targetIndex === -1) {
    appendLog(projectRoot, "ERROR", "reopen", `INVALID_TARGET: "${targetStep}"`);
    return {
      type: "error",
      code: "INVALID_TARGET",
      message: `Invalid reopen target "${targetStep}". Valid steps: bootstrap, ${sequence.join(", ")}`,
      recoverable: false,
    };
  }

  // Reset state to target step
  const previousStep = state.step; // "done"
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
  state.tests = null;
  state.failing_tests = [];
  state.lint_pass = null;
  state.human_note = options.humanNote ?? null;
  state.reopened_from = targetStep;  // Feature 1: Track reopen target for escalation

  writeState(projectRoot, state);

  appendLog(projectRoot, "INFO", "reopen", `Reopened story "${state.story}" from "${previousStep}" to "${targetStep}"${options.humanNote ? ` note: "${options.humanNote}"` : ""}`);

  // Feature 2: Append entry to .ai/history.md
  const isoTimestamp = new Date().toISOString();
  const historyEntry = `### Reopen — ${state.story} → ${targetStep}
- **Date**: ${isoTimestamp}
- **From**: ${previousStep} → ${targetStep}
- **Note**: ${options.humanNote ?? "N/A"}`;
  appendHistory(projectRoot, historyEntry);

  return {
    type: "ok",
    state,
    message: `Reopened story "${state.story}" at step "${targetStep}" (attempt 1, status: pending)`,
  };
}

// ─── Review (On-Demand Review Session) ───────────────────────────────────────

/**
 * Generate a Review Session prompt for the current project.
 *
 * This is a STATELESS operation — it reads project state but does NOT
 * mutate STATE.json. The caller (CC executor) receives the prompt and
 * runs the review; results are acted on by the human (reopen, new US, etc.).
 *
 * Works on non-ACF projects too (detectFramework level 0): generates a
 * lighter review prompt based on whatever files exist.
 *
 * Review Session checks (from Lifecycle v0.9):
 *   1. Code Review — diff quality, naming, duplication
 *   2. Spec-Code Coherence — BDD ↔ tests ↔ impl alignment
 *   3. Regression — all existing tests still pass
 *   4. Security Scan — no hardcoded secrets, .gitignore coverage
 *   5. Memory Audit — PROJECT_MEMORY accuracy
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */
export function review(
  projectRoot: string,
): { type: "review_prompt"; prompt: string; fw_lv: number } {
  const framework = detectFramework(projectRoot);
  const prompt = buildReviewPrompt(projectRoot, framework.level);
  return {
    type: "review_prompt",
    prompt,
    fw_lv: framework.level,
  };
}

/**
 * Build the review session prompt based on framework adoption level.
 */
function buildReviewPrompt(projectRoot: string, fwLevel: number): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  ON-DEMAND REVIEW SESSION");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  if (fwLevel >= 2) {
    // Full ACF project — rich review
    let state: State | null = null;
    try { state = readState(projectRoot); } catch { /* no state */ }

    lines.push(`Project: ${state?.project ?? "(unknown)"}`);
    lines.push(`Story: ${state?.story ?? "(no active story)"}`);
    lines.push(`Current Step: ${state?.step ?? "(unknown)"}`);
    lines.push("");
    lines.push("## Review Checklist");
    lines.push("");
    lines.push("### 1. Code Review");
    lines.push("- Check recent changes for naming consistency, duplication, dead code");
    lines.push("- Verify diff-only discipline: only files related to the story should be modified");
    lines.push("");
    lines.push("### 2. Spec-Code Coherence");
    lines.push("- Read BDD scenarios in docs/bdd/ and verify each has a corresponding test");
    lines.push("- Read SDD Delta in docs/deltas/ and verify implementation matches");
    lines.push("- Check that API contracts in docs/api/ are synchronized");
    lines.push("");
    lines.push("### 3. Regression");
    lines.push("- Run the project's test suite and confirm all tests pass");
    lines.push("- If tests fail, record them in ISSUES section of PROJECT_MEMORY.md");
    lines.push("");
    lines.push("### 4. Security Scan");
    lines.push("- grep for common secret patterns: password=, apikey=, token=, BEGIN RSA PRIVATE KEY");
    lines.push("- Verify .gitignore covers: .env, *.key, credentials.json, *.pem");
    lines.push("- Confirm test fixtures use mock/fake values, not real credentials");
    lines.push("");
    lines.push("### 5. Memory Audit");
    lines.push("- Read PROJECT_MEMORY.md and verify NOW/TESTS/NEXT/ISSUES sections are accurate");
    lines.push("- Check .ai/history.md for completeness");
    lines.push("- Verify HANDOFF.md reflects the latest session state");
  } else if (fwLevel === 1) {
    // Partial ACF — moderate review
    lines.push("## Review Checklist (Partial ACF Project)");
    lines.push("");
    lines.push("### 1. Code Review");
    lines.push("- Check recent changes for quality, naming, duplication");
    lines.push("");
    lines.push("### 2. Spec Coherence");
    lines.push("- If BDD/SDD docs exist, verify alignment with code");
    lines.push("");
    lines.push("### 3. Regression");
    lines.push("- Run available test suite and confirm all tests pass");
    lines.push("");
    lines.push("### 4. Security Scan");
    lines.push("- grep for hardcoded secrets (password=, apikey=, token=)");
    lines.push("- Verify .gitignore covers sensitive file patterns");
    lines.push("");
    lines.push("### 5. Memory Check");
    lines.push("- If PROJECT_MEMORY.md exists, verify it is up to date");
  } else {
    // Non-ACF project — lightweight review
    lines.push("## Review Checklist (Non-ACF Project)");
    lines.push("");
    lines.push("### 1. Code Review");
    lines.push("- Review recent git changes (git log + git diff) for quality");
    lines.push("- Check for dead code, duplication, naming issues");
    lines.push("");
    lines.push("### 2. Test Check");
    lines.push("- Locate and run the project's test suite (if any)");
    lines.push("- Report test results");
    lines.push("");
    lines.push("### 3. Security Scan");
    lines.push("- grep for hardcoded secrets (password=, apikey=, token=)");
    lines.push("- Check .gitignore for sensitive patterns");
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  OUTPUT FORMAT");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("For each check, report:");
  lines.push("  PASS — <brief note>");
  lines.push("  WARN — <issue description>");
  lines.push("  FAIL — <issue description + suggested action>");
  lines.push("");
  lines.push("At the end, provide a summary with recommended actions:");
  lines.push("  - REOPEN <US-XXX> at <step> — if existing story needs rework");
  lines.push("  - NEW US — <brief description> — if a new story is needed");
  lines.push("  - ISSUE — <description> — record in PROJECT_MEMORY.md ISSUES");
  lines.push("  - ALL CLEAR — no issues found");
  lines.push("");

  return lines.join("\n");
}

// ─── Triage (ISSUES → Actionable Plan) ──────────────────────────────────────

/**
 * Read unfixed ISSUES from PROJECT_MEMORY.md and generate a triage prompt.
 *
 * This is a STATELESS operation — reads files but does NOT mutate STATE.json.
 * The triage prompt asks the executor (CC) to classify each issue and
 * recommend actions (reopen US, create new US, or dismiss).
 *
 * Requires PROJECT_MEMORY.md to exist with an ISSUES section.
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */
export function triage(
  projectRoot: string,
): { type: "triage_prompt"; prompt: string; issues: string[]; fw_lv: number }
 | { type: "error"; code: string; message: string; recoverable: boolean } {
  const framework = detectFramework(projectRoot);

  // Read PROJECT_MEMORY.md
  const memoryPath = join(projectRoot, "PROJECT_MEMORY.md");
  if (!existsSync(memoryPath)) {
    return {
      type: "error",
      code: "NO_MEMORY",
      message: "PROJECT_MEMORY.md not found. Cannot triage without ISSUES section.",
      recoverable: false,
    };
  }

  const memory = readFileSync(memoryPath, "utf-8");
  const issues = parseIssuesFromMemory(memory);

  if (issues.length === 0) {
    return {
      type: "error",
      code: "NO_ISSUES",
      message: "No unfixed ISSUES found in PROJECT_MEMORY.md. Nothing to triage.",
      recoverable: false,
    };
  }

  const prompt = buildTriagePrompt(projectRoot, issues, framework.level);
  return {
    type: "triage_prompt",
    prompt,
    issues,
    fw_lv: framework.level,
  };
}

/**
 * Parse ISSUES lines from PROJECT_MEMORY.md.
 * Looks for lines starting with "- [ ]" under a section containing "ISSUES".
 * Filters out already-checked items "- [x]".
 */
function parseIssuesFromMemory(memory: string): string[] {
  const lines = memory.split("\n");
  let inIssuesSection = false;
  const issues: string[] = [];

  for (const line of lines) {
    // Detect ISSUES section header (## ISSUES, ### ISSUES, or just ISSUES:)
    if (/^#{1,4}\s*ISSUES/i.test(line) || /^ISSUES\s*:/i.test(line)) {
      inIssuesSection = true;
      continue;
    }

    // Exit ISSUES section on next header
    if (inIssuesSection && /^#{1,4}\s/.test(line) && !/ISSUES/i.test(line)) {
      inIssuesSection = false;
      continue;
    }

    // Collect unchecked items
    if (inIssuesSection && /^-\s*\[\s*\]/.test(line)) {
      issues.push(line.replace(/^-\s*\[\s*\]\s*/, "").trim());
    }
  }

  return issues;
}

/**
 * Build the triage prompt with parsed issues.
 */
function buildTriagePrompt(
  projectRoot: string,
  issues: string[],
  fwLevel: number,
): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  TRIAGE SESSION");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  let state: State | null = null;
  try { state = readState(projectRoot); } catch { /* no state */ }
  if (state) {
    lines.push(`Project: ${state.project ?? "(unknown)"}`);
    lines.push(`Current Story: ${state.story ?? "(none)"}`);
    lines.push(`Current Step: ${state.step}`);
    lines.push("");
  }

  lines.push(`## Unfixed ISSUES (${issues.length})`);
  lines.push("");
  for (let i = 0; i < issues.length; i++) {
    lines.push(`  ${i + 1}. ${issues[i]}`);
  }
  lines.push("");

  lines.push("## Triage Instructions");
  lines.push("");
  lines.push("For each issue above, analyze and classify:");
  lines.push("");
  lines.push("  A. REOPEN <US-XXX> at <step>");
  lines.push("     → Issue belongs to an existing story; reopen it at the appropriate step.");
  lines.push("     → The human will run: orchestrator reopen <project> <step>");
  lines.push("");
  lines.push("  B. NEW US: <title>");
  lines.push("     → Issue requires a new User Story. Write a 1-2 sentence description.");
  lines.push("     → The human will create the US and run: orchestrator start-story <project> <US-XXX>");
  lines.push("");
  lines.push("  C. DISMISS: <reason>");
  lines.push("     → Issue is resolved, duplicate, or no longer relevant.");
  lines.push("     → The human will mark it [x] in PROJECT_MEMORY.md.");
  lines.push("");

  if (fwLevel >= 2) {
    lines.push("## Context Files");
    lines.push("Read these files to inform your triage decisions:");
    lines.push("  - PROJECT_MEMORY.md (full context: NOW, TESTS, NEXT, ISSUES)");
    lines.push("  - .ai/history.md (completed work log)");
    lines.push("  - docs/bdd/ (BDD scenarios for existing stories)");
    lines.push("  - docs/deltas/ (SDD deltas for existing stories)");
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  OUTPUT FORMAT");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("Produce a triage plan as a numbered list matching the issues above:");
  lines.push("");
  lines.push("  1. [A] REOPEN US-001 at impl — <reason>");
  lines.push("  2. [B] NEW US: \"Add input validation for email field\" — <reason>");
  lines.push("  3. [C] DISMISS — resolved in commit abc123");
  lines.push("");
  lines.push("End with a SUMMARY: X to reopen, Y new US, Z dismissed.");
  lines.push("This plan is HUMAN-GATED — no actions will be taken automatically.");
  lines.push("");

  return lines.join("\n");
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
