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

import { readFileSync, existsSync } from "fs";
import { join } from "path";

import { readState } from "./state";
import type { Reason } from "./state";
import {
  dispatch,
  applyHandoff,
  approveReview,
  rejectReview,
  startStory,
  startCustom,
  queryProjectStatus,
  detectFramework,
  listProjects,
  type DispatchResult,
  type ProjectStatus,
  type FrameworkDetection,
  type ProjectEntry,
} from "./dispatch";

// ─── Result Types ───────────────────────────────────────────────────────────

export type AutoResult =
  | { action: "query"; data: ProjectStatus; memory?: string; handoff?: string }
  | { action: "dispatched"; step: string; attempt: number; prompt: string; fw_lv: number }
  | { action: "done"; story: string; summary: string }
  | { action: "needs_human"; step: string; message: string }
  | { action: "blocked"; step: string; reason: string }
  | { action: "already_running"; step: string; elapsed_min: number }
  | { action: "timeout"; step: string; elapsed_min: number }
  | { action: "approved"; note?: string }
  | { action: "rejected"; reason: string; note?: string }
  | { action: "detected"; framework: FrameworkDetection }
  | { action: "listed"; projects: ProjectEntry[] }
  | { action: "error"; message: string };

// ─── Classification ─────────────────────────────────────────────────────────

type Intent =
  | { type: "query" }
  | { type: "approve"; note?: string }
  | { type: "reject"; reason: Reason; note?: string }
  | { type: "start_story"; storyId: string }
  | { type: "continue" }
  | { type: "detect" }
  | { type: "list" }
  | { type: "custom"; instruction: string };

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
    const note = msg.replace(/^(approve|核准|lgtm|通過|approved|ok)\s*/i, "").trim() || undefined;
    return { type: "approve", note };
  }

  // ── Reject ──
  if (/^(reject|退回|不行|rejected)/i.test(msg)) {
    const rest = msg.replace(/^(reject|退回|不行|rejected)\s*/i, "").trim();
    const { reason, note } = extractRejectReason(rest);
    return { type: "reject", reason, note };
  }

  // ── Start Story (must be before query — "start US-007" is not a query) ──
  const storyMatch = msg.match(/(?:start\s*story|開始\s*story|開新\s*story|start)\s+(US-\d+)/i)
    || msg.match(/^(US-\d+)/i);
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
  if (/^(繼續|continue|dispatch|next|下一步|run|執行|go|proceed)\s*$/i.test(msg)) {
    return { type: "continue" };
  }

  // ── Fallback: Custom task ──
  return { type: "custom", instruction: msg };
}

/** Check if the message is a read-only query */
function isQuery(lower: string): boolean {
  const queryPatterns = [
    /狀態/, /status/, /什麼步驟/, /what\s*step/, /which\s*step/,
    /測試/, /tests?/, /進度/, /progress/,
    /還有什麼/, /what's\s*next/, /what\s*next/, /what's\s*left/,
    /history/, /歷史/, /上次/, /last\s*(session|time)/,
    /怎麼樣/, /how.*project/, /how.*going/,
    /目前/, /current/, /看一下/, /看看/, /查一下/, /check\s*status/,
    /哪個步驟/, /卡住/, /blocked/, /why.*block/,
    /summary/, /摘要/, /report/, /報告/,
    /打開/, /open\s*project/,
  ];
  return queryPatterns.some((p) => p.test(lower));
}

/** Extract reject reason from the rest of the message */
function extractRejectReason(rest: string): { reason: Reason; note?: string } {
  const reasonMap: Record<string, Reason> = {
    clarification: "needs_clarification",
    需要說明: "needs_clarification",
    不清楚: "needs_clarification",
    constitution: "constitution_violation",
    架構違反: "constitution_violation",
    scope: "scope_warning",
    範圍: "scope_warning",
    nfr: "nfr_missing",
    timeout: "test_timeout",
    超時: "test_timeout",
  };

  for (const [keyword, reason] of Object.entries(reasonMap)) {
    if (rest.toLowerCase().includes(keyword)) {
      const note = rest.replace(new RegExp(keyword, "i"), "").trim() || undefined;
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
 *
 * Usage:
 *   orchestrator auto ./project "目前狀態如何"
 *   orchestrator auto ./project "繼續"
 *   orchestrator auto ./project "幫我 refactor auth module"
 *   orchestrator auto ./project "approve"
 */
export function auto(projectRoot: string, message: string): AutoResult {
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
        return { action: "detected", framework: detectFramework(projectRoot) };

      case "list":
        // Use projectRoot as workspace root for listing
        return { action: "listed", projects: listProjects(projectRoot) };

      case "custom":
        return handleCustom(projectRoot, intent.instruction);
    }
  } catch (err: any) {
    return { action: "error", message: err.message ?? String(err) };
  }
}

// ─── Intent Handlers ────────────────────────────────────────────────────────

function handleQuery(projectRoot: string): AutoResult {
  const data = queryProjectStatus(projectRoot);

  // Attach memory and handoff content if available
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

function handleApprove(projectRoot: string, note?: string): AutoResult {
  try {
    approveReview(projectRoot, note);
    return { action: "approved", note };
  } catch (err: any) {
    return { action: "error", message: err.message };
  }
}

function handleReject(projectRoot: string, reason: Reason, note?: string): AutoResult {
  try {
    rejectReview(projectRoot, reason, note);
    return { action: "rejected", reason, note };
  } catch (err: any) {
    return { action: "error", message: err.message };
  }
}

function handleStartStory(projectRoot: string, storyId: string): AutoResult {
  startStory(projectRoot, storyId);
  return wrapDispatchResult(dispatch(projectRoot));
}

function handleDispatch(projectRoot: string): AutoResult {
  return wrapDispatchResult(dispatch(projectRoot));
}

function handleCustom(projectRoot: string, instruction: string): AutoResult {
  // Check if there's an agent-teams keyword
  const agentTeams = /agent.?teams?|平行|多\s*agent|agents/i.test(instruction);
  startCustom(projectRoot, instruction, { agentTeams });
  return wrapDispatchResult(dispatch(projectRoot));
}

/** Convert DispatchResult to AutoResult */
function wrapDispatchResult(result: DispatchResult): AutoResult {
  switch (result.type) {
    case "dispatched":
      return {
        action: "dispatched",
        step: result.step,
        attempt: result.attempt,
        prompt: result.prompt,
        fw_lv: result.fw_lv,
      };
    case "done":
      return { action: "done", story: result.story, summary: result.summary };
    case "needs_human":
      return { action: "needs_human", step: result.step, message: result.message };
    case "blocked":
      return { action: "blocked", step: result.step, reason: result.reason };
    case "already_running":
      return { action: "already_running", step: result.step, elapsed_min: result.elapsed_min };
    case "timeout":
      return { action: "timeout", step: result.step, elapsed_min: result.elapsed_min };
  }
}
