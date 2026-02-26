/**
 * auto.ts — Unified entry point for OpenClaw integration
 *
 * Classifies a raw user message into an action (query, dispatch, approve, etc.)
 * using keyword-based matching (zero LLM tokens), then routes to the appropriate
 * orchestrator function.
 *
 * OpenClaw only needs to call:
 *   orchestrator auto <project-root> "<user message>"
 *
 * and gets back a JSON result with an `action` field telling it what happened.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  dispatch,
  approveReview,
  rejectReview,
  startStory,
  startCustom,
  detectFramework,
  queryProjectStatus,
  listProjects,
} from "./dispatch";
import { getRule } from "./rules";
import { readState, sanitize, writeState } from "./state";

// ─── Intent Types ────────────────────────────────────────────────────────────

type Intent =
  | { type: "query" }
  | { type: "approve"; note?: string }
  | { type: "reject"; reason: string; note?: string }
  | { type: "start_story"; storyId: string }
  | { type: "continue" }
  | { type: "detect" }
  | { type: "list" }
  | { type: "custom"; instruction: string };

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify a raw user message into an intent.
 * Pure keyword/regex matching — zero LLM tokens.
 *
 * Priority order matters: more specific patterns are checked first.
 */
export function classify(message: string): Intent {
  const msg = message.trim();
  const lower = msg.toLowerCase();

  // ── Approve ──
  if (/^(approve|核准|lgtm|通過|approved|ok\s*$)/i.test(msg)) {
    const note =
      msg.replace(/^(approve|核准|lgtm|通過|approved|ok)\s*/i, "").trim() ||
      undefined;
    return { type: "approve", note };
  }

  // ── Reject ──
  if (/^(reject|退回|不行|rejected)/i.test(msg)) {
    const rest = msg
      .replace(/^(reject|退回|不行|rejected)\s*/i, "")
      .trim();
    const { reason, note } = extractRejectReason(rest);
    return { type: "reject", reason, note };
  }

  // ── Start Story (must be before query — "start US-007" is not a query) ──
  const storyMatch =
    msg.match(
      /(?:start\s*story|開始\s*story|開新\s*story|start)\s+(US-\d+)/i,
    ) || msg.match(/^(US-\d+)/i);
  if (storyMatch) {
    return { type: "start_story", storyId: storyMatch[1] };
  }

  // ── List projects ──
  if (/列出|list.*project|所有專案|all\s*projects/i.test(lower)) {
    return { type: "list" };
  }

  // ── Detect framework ──
  if (/framework|有沒有用|adoption|detect/i.test(lower)) {
    return { type: "detect" };
  }

  // ── Query (information requests — no code changes) ──
  if (isQuery(lower)) {
    return { type: "query" };
  }

  // ── Continue / Dispatch ──
  if (
    /^(繼續|continue|dispatch|next|下一步|run|執行|go|proceed)\s*$/i.test(msg)
  ) {
    return { type: "continue" };
  }

  // ── Fallback: Custom task ──
  return { type: "custom", instruction: msg };
}

/** Check if the message is a read-only query */
function isQuery(lower: string): boolean {
  const queryPatterns = [
    /狀態/,
    /status/,
    /什麼步驟/,
    /what\s*step/,
    /which\s*step/,
    /測試/,
    /tests?/,
    /進度/,
    /progress/,
    /還有什麼/,
    /what's\s*next/,
    /what\s*next/,
    /what's\s*left/,
    /history/,
    /歷史/,
    /上次/,
    /last\s*(session|time)/,
    /怎麼樣/,
    /how.*project/,
    /how.*going/,
    /目前/,
    /current/,
    /看一下/,
    /看看/,
    /查一下/,
    /check\s*status/,
    /哪個步驟/,
    /卡住/,
    /blocked/,
    /why.*block/,
    /summary/,
    /摘要/,
    /report/,
    /報告/,
    /打開/,
    /open\s*project/,
  ];
  return queryPatterns.some((p) => p.test(lower));
}

/** Extract reject reason from the rest of the message */
function extractRejectReason(rest: string): {
  reason: string;
  note?: string;
} {
  const reasonMap: Record<string, string> = {
    clarification: "needs_clarification",
    "需要說明": "needs_clarification",
    "不清楚": "needs_clarification",
    constitution: "constitution_violation",
    "架構違反": "constitution_violation",
    scope: "scope_warning",
    "範圍": "scope_warning",
    nfr: "nfr_missing",
    timeout: "test_timeout",
    "超時": "test_timeout",
  };

  for (const [keyword, reason] of Object.entries(reasonMap)) {
    if (rest.toLowerCase().includes(keyword)) {
      const note =
        rest.replace(new RegExp(keyword, "i"), "").trim() || undefined;
      return { reason, note };
    }
  }

  // Default reason
  return { reason: "needs_clarification", note: rest || undefined };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Unified orchestrator entry point.
 *
 * Takes a project root and a raw user message, classifies the intent,
 * and routes to the appropriate function. Returns a JSON-serializable result.
 */
export function auto(
  projectRoot: string,
  message: string,
): Record<string, unknown> {
  const intent = classify(message);

  try {
    switch (intent.type) {
      case "query":
        return handleQuery(projectRoot);
      case "approve":
        return handleApprove(projectRoot, intent.note);
      case "reject":
        return handleReject(projectRoot, intent.reason, intent.note);
      case "start_story":
        return handleStartStory(projectRoot, intent.storyId);
      case "continue":
        return handleDispatch(projectRoot);
      case "detect":
        return {
          action: "detected",
          framework: detectFramework(projectRoot),
        };
      case "list":
        return {
          action: "listed",
          projects: listProjects(projectRoot),
        };
      case "custom":
        return handleCustom(projectRoot, intent.instruction);
    }
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);

    // Defense-in-depth: if validation failed due to corrupted STATE.json,
    // attempt sanitize + retry once before giving up.
    if (
      /Invalid (status|reason)/.test(msg) &&
      (intent.type === "continue" ||
        intent.type === "query" ||
        intent.type === "approve")
    ) {
      try {
        const state = (() => {
          const { readFileSync } = require("fs");
          const { join } = require("path");
          const raw = readFileSync(
            join(projectRoot, ".ai", "STATE.json"),
            "utf-8",
          );
          return JSON.parse(raw);
        })();
        const warnings = sanitize(state);
        if (warnings.length > 0) {
          writeState(projectRoot, state);
          // Retry the original intent
          switch (intent.type) {
            case "continue":
              return {
                ...wrapDispatchResult(dispatch(projectRoot)),
                _sanitized: warnings,
              };
            case "query":
              return { ...handleQuery(projectRoot), _sanitized: warnings };
            case "approve":
              return {
                ...handleApprove(projectRoot, (intent as any).note),
                _sanitized: warnings,
              };
          }
        }
      } catch {
        // sanitize recovery also failed — fall through to original error
      }
    }

    return {
      action: "error",
      message: msg,
    };
  }
}

// ─── Intent Handlers ────────────────────────────────────────────────────────

function handleQuery(projectRoot: string): Record<string, unknown> {
  const data = queryProjectStatus(projectRoot);

  let memory: string | undefined;
  let handoff: string | undefined;

  const memoryPath = join(projectRoot, "PROJECT_MEMORY.md");
  if (existsSync(memoryPath)) {
    memory = readFileSync(memoryPath, "utf-8").slice(0, 2000);
  }

  const handoffPath = join(projectRoot, ".ai", "HANDOFF.md");
  if (existsSync(handoffPath)) {
    handoff = readFileSync(handoffPath, "utf-8").slice(0, 2000);
  }

  return { action: "query", data, memory, handoff };
}

function handleApprove(
  projectRoot: string,
  note?: string,
): Record<string, unknown> {
  const result = approveReview(projectRoot, note);
  if (result.type === "error") {
    return { action: "error", code: result.code, message: result.message };
  }
  return { action: "approved", note };
}

function handleReject(
  projectRoot: string,
  reason: string,
  note?: string,
): Record<string, unknown> {
  const result = rejectReview(projectRoot, reason, note);
  if (result.type === "error") {
    return { action: "error", code: result.code, message: result.message };
  }
  return { action: "rejected", reason, note };
}

function handleStartStory(
  projectRoot: string,
  storyId: string,
): Record<string, unknown> {
  const result = startStory(projectRoot, storyId);
  if (result.type === "error") {
    return { action: "error", code: result.code, message: result.message };
  }
  return wrapDispatchResult(dispatch(projectRoot));
}

function handleDispatch(projectRoot: string): Record<string, unknown> {
  return wrapDispatchResult(dispatch(projectRoot));
}

function handleCustom(
  projectRoot: string,
  instruction: string,
): Record<string, unknown> {
  const agentTeams = /agent.?teams?|平行|多\s*agent|agents/i.test(
    instruction,
  );
  startCustom(projectRoot, instruction, { agentTeams });
  return wrapDispatchResult(dispatch(projectRoot));
}

/** Convert DispatchResult to AutoResult */
function wrapDispatchResult(
  result: ReturnType<typeof dispatch>,
): Record<string, unknown> {
  switch (result.type) {
    case "dispatched": {
      // Look up next_step so the caller knows the pipeline trajectory
      let next_step: string | null = null;
      try {
        const rule = getRule(result.step);
        next_step = rule.next_on_pass;
      } catch {
        // step might be "done" or unknown — leave null
      }
      return {
        action: "dispatched",
        step: result.step,
        attempt: result.attempt,
        next_step,
        prompt: result.prompt,
        fw_lv: result.fw_lv,
        caller_instruction:
          "Task has been DISPATCHED to Claude Code but is NOT yet complete. " +
          "You MUST wait for the executor to finish (hook notification or poll 'orchestrator status'). " +
          "Do NOT assume completion. Do NOT fabricate results. Do NOT advance to the next step.",
      };
    }
    case "done":
      return {
        action: "done",
        story: result.story,
        summary: result.summary,
        caller_instruction:
          "Story is fully completed. No further dispatch is needed for this story.",
      };
    case "needs_human":
      return {
        action: "needs_human",
        step: result.step,
        message: result.message,
        caller_instruction:
          "This step requires human review. Present the current state to the user and wait for their approval or rejection. " +
          "Do NOT auto-approve. Do NOT skip this step.",
      };
    case "blocked":
      return {
        action: "blocked",
        step: result.step,
        reason: result.reason,
        caller_instruction:
          "This step is blocked and cannot proceed. Inform the user of the blocking reason and wait for resolution.",
      };
    case "already_running":
      return {
        action: "already_running",
        step: result.step,
        elapsed_min: result.elapsed_min,
        last_error: result.last_error,
        caller_instruction:
          "A task is already running for this step. Do NOT dispatch again. " +
          "Wait for the current execution to complete before taking any action.",
      };
    case "timeout":
      return {
        action: "timeout",
        step: result.step,
        elapsed_min: result.elapsed_min,
        last_error: result.last_error,
        caller_instruction:
          "The current task has timed out. Inform the user and wait for instructions on whether to retry or skip.",
      };
    case "error":
      return {
        action: "error",
        code: result.code,
        message: result.message,
        step: result.step,
        recoverable: result.recoverable,
        caller_instruction: result.recoverable
          ? "An error occurred but may be recoverable. Try 'orchestrator status' to inspect STATE.json, then consider rollback or retry."
          : "An unrecoverable error occurred. Report the error details to the human for manual resolution.",
      };
  }
}
