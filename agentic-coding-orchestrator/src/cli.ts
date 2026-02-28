#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for the Agentic Coding Orchestrator
 *
 * Commands:
 *   init <project-root> <project-name>          Initialize .ai/STATE.json
 *   start-story <project-root> <story-id>       Begin a new User Story (micro-waterfall)
 *   start-custom <project-root> <instruction>   Begin a custom ad-hoc task
 *   dispatch <project-root>                     Dispatch next step (prints prompt)
 *   peek <project-root>                         [FIX P1] Read-only dispatch preview
 *   apply-handoff <project-root>                Parse HANDOFF.md → update STATE
 *   approve <project-root> [note]               Approve review step
 *   reject <project-root> <reason> [note]       Reject review step
 *   rollback <project-root> <target-step>       Roll back to a previous step [v0.6.0]
 *   check-prereqs <project-root>                Check prerequisite files [v0.6.0]
 *   status <project-root>                       Print current STATE.json
 *   reopen <project-root> <target-step>         Reopen completed story at step [v0.8.0]
 *   review <project-root>                       On-demand review session prompt [v0.8.0]
 *   triage <project-root>                       Triage ISSUES into action plan [v0.8.0]
 */

import { resolve } from "path";
import { execSync } from "child_process";
import { readState, writeState, initState, writeClaudeMd, appendLog } from "./state";
import {
  dispatch,
  peek,
  applyHandoff,
  runPostCheck,
  approveReview,
  rejectReview,
  startStory,
  startCustom,
  detectFramework,
  queryProjectStatus,
  listProjects,
  rollback,
  checkPrerequisites,
  reopen,
  review,
  triage,
} from "./dispatch";
import { auto } from "./auto";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const [, , command, ...args] = process.argv;

function usage(): never {
  console.error(`Usage: orchestrator <command> [args]

Commands:
  auto <project-root> <message...>                 Unified entry — classify message & route automatically
  init <project-root> <project-name>              Initialize .ai/STATE.json
  start-story <project-root> <story-id>           Begin a new User Story (micro-waterfall)
  start-custom <project-root> <instruction>       Begin a custom ad-hoc task
  dispatch <project-root>                         Dispatch next step (prints prompt to stdout)
  peek <project-root>                             [NEW] Read-only dispatch preview (no state mutation)
  apply-handoff <project-root>           Parse HANDOFF.md → update STATE.json
  post-check <project-root>              Run step's post_check command
  approve <project-root> [note]          Approve review step
  reject <project-root> <reason> [note]  Reject review step
  status <project-root>                  Print current STATE.json
  rollback <project-root> <target-step>  Roll back to a previous step [v0.6.0]
  check-prereqs <project-root>           Check prerequisite files for current step [v0.6.0]
  query <project-root>                   Project status summary (for OpenClaw)
  detect <project-root>                  Check if project uses the framework
  list-projects <workspace-root>         List all projects in workspace
  reopen <project-root> <target-step>    Reopen completed story at step [v0.8.0]
  review <project-root>                  Generate on-demand review session prompt [v0.8.0]
  triage <project-root>                  Triage unfixed ISSUES into action plan [v0.8.0]
`);
  process.exit(1);
}

function resolveRoot(raw: string | undefined): string {
  if (!raw) {
    console.error("Error: <project-root> is required");
    process.exit(1);
  }
  return resolve(raw);
}

try {
  switch (command) {
    case "--version":
    case "-v": {
      const pkgPath = join(dirname(__dirname), "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      console.log(pkg.version);
      break;
    }

    case "auto": {
      const projectRoot = resolveRoot(args[0]);
      const message = args.slice(1).join(" ");
      if (!message) {
        console.error("Error: <message> is required");
        console.error('Example: orchestrator auto ./project "目前狀態如何"');
        process.exit(1);
      }

      const result = auto(projectRoot, message);
      // JSON to stdout (machine-readable)
      console.log(JSON.stringify(result, null, 2));

      // Human-friendly summary to stderr
      switch ((result as Record<string, unknown>).action) {
        case "query":
          console.error(
            `[auto] Query: ${(result as any).data.project} — step=${(result as any).data.step}, status=${(result as any).data.status}`,
          );
          break;
        case "dispatched":
          console.error(
            `[auto] Dispatched: step=${(result as any).step}, attempt=${(result as any).attempt}, fw_lv=${(result as any).fw_lv}`,
          );
          break;
        case "done":
          console.error(`[auto] Done: ${(result as any).summary}`);
          break;
        case "needs_human":
          console.error(`[auto] Needs human: ${(result as any).message}`);
          break;
        case "blocked":
          console.error(`[auto] Blocked: ${(result as any).reason}`);
          break;
        case "approved":
          console.error(
            `[auto] Approved${(result as any).note ? ` (note: ${(result as any).note})` : ""}`,
          );
          break;
        case "rejected":
          console.error(
            `[auto] Rejected: ${(result as any).reason}${(result as any).note ? ` — ${(result as any).note}` : ""}`,
          );
          break;
        case "detected":
          console.error(
            `[auto] Framework level: ${(result as any).framework.level}`,
          );
          break;
        case "listed":
          console.error(
            `[auto] Found ${(result as any).projects.length} project(s)`,
          );
          break;
        case "review":
          console.error(
            `[auto] Review session prompt generated (fw_lv=${(result as any).fw_lv})`,
          );
          break;
        case "triage":
          console.error(
            `[auto] Triage prompt generated for ${(result as any).issues.length} issue(s) (fw_lv=${(result as any).fw_lv})`,
          );
          break;
        case "reopened":
          console.error(
            `[auto] Reopened: ${(result as any).story} at step ${(result as any).step}`,
          );
          break;
        case "error":
          console.error(`[auto] Error: ${(result as any).message}`);
          process.exit(1);
          break;
      }
      break;
    }

    case "init": {
      const projectRoot = resolveRoot(args[0]);
      const projectName = args[1];
      if (!projectName) {
        console.error("Error: <project-name> is required");
        process.exit(1);
      }
      const { created, state } = initState(projectRoot, projectName);
      if (created) {
        console.log(`Initialized .ai/STATE.json for "${projectName}"`);
      } else {
        console.log(
          `STATE.json already exists (step: ${state.step}, status: ${state.status})`,
        );
      }
      // Always ensure CLAUDE.md exists (idempotent, won't overwrite)
      const claudeCreated = writeClaudeMd(projectRoot, projectName);
      if (claudeCreated) {
        console.log(
          `Created CLAUDE.md (CC will auto-detect ACF on session start)`,
        );
      }
      break;
    }

    case "start-story": {
      const projectRoot = resolveRoot(args[0]);
      const storyId = args[1];
      if (!storyId) {
        console.error("Error: <story-id> is required");
        process.exit(1);
      }
      const force = args.includes("--force");
      const result = startStory(projectRoot, storyId, { force });
      if (result.type === "error") {
        console.log(JSON.stringify(result, null, 2));
        console.error(`[start-story] ERROR (${result.code}): ${result.message}`);
        process.exit(1);
      }
      const state = result.state;
      console.log(
        `Started story ${storyId} (step: ${state.step}, attempt: ${state.attempt})`,
      );
      break;
    }

    case "start-custom": {
      const projectRoot = resolveRoot(args[0]);
      const instruction = args[1];
      if (!instruction) {
        console.error("Error: <instruction> is required");
        console.error(
          'Example: orchestrator start-custom ./project "Refactor auth module into separate package"',
        );
        process.exit(1);
      }
      const label = args[2] || undefined; // optional label
      const agentTeams = args[3] === "--agent-teams";
      const customResult = startCustom(projectRoot, instruction, {
        label,
        agentTeams,
      });
      if (customResult.type === "error") {
        console.log(JSON.stringify(customResult, null, 2));
        console.error(`[start-custom] ERROR (${customResult.code}): ${customResult.message}`);
        process.exit(customResult.recoverable ? 2 : 1);
      }
      const customState = customResult.state;
      console.log(`Started custom task: "${instruction}"`);
      console.log(
        `  label: ${customState.story}, step: ${customState.step}, task_type: ${customState.task_type}`,
      );
      break;
    }

    case "dispatch": {
      const projectRoot = resolveRoot(args[0]);
      const result = dispatch(projectRoot);

      switch (result.type) {
        case "dispatched": {
          // Print prompt to stdout (can be piped to claude -p)
          console.log(result.prompt);
          // Print <task-meta> JSON block to stdout — dispatch-claude-code.sh parses this
          const taskMeta = {
            task_name: `${result.story}-${result.step}`,
            project: result.project,
            story: result.story,
            step: result.step,
            attempt: result.attempt,
            fw_lv: result.fw_lv,
          };
          console.log(`\n<task-meta>\n${JSON.stringify(taskMeta, null, 2)}\n</task-meta>`);
          // Print metadata to stderr for human readability
          console.error(
            `[dispatch] step=${result.step} attempt=${result.attempt}`,
          );
          appendLog(projectRoot, "INFO", "cli:dispatch", `dispatched step="${result.step}" attempt=${result.attempt} fw_lv=${result.fw_lv}`);
          break;
        }
        case "done":
          console.error(`[dispatch] DONE: ${result.summary}`);
          break;
        case "needs_human":
          console.error(`[dispatch] NEEDS HUMAN REVIEW`);
          console.error(result.message);
          break;
        case "blocked":
          console.error(`[dispatch] BLOCKED: ${result.reason}`);
          // [FIX P1] Use exit(0) — blocked is an expected orchestrator state,
          // not an error. exit(1) breaks dispatch-claude-code.sh (set -e).
          process.exit(0);
          break;
        case "already_running":
          console.error(
            `[dispatch] Already running (${result.elapsed_min} min)`,
          );
          break;
        case "timeout":
          console.error(
            `[dispatch] TIMEOUT at ${result.step} (${result.elapsed_min} min)`,
          );
          // [FIX P1] Use exit(0) — timeout is an expected orchestrator state.
          // exit(1) would abort dispatch-claude-code.sh before it can retry.
          process.exit(0);
          break;
        case "error":
          console.log(JSON.stringify(result, null, 2));
          console.error(`[dispatch] ERROR (${result.code}): ${result.message}`);
          appendLog(projectRoot, "ERROR", "cli:dispatch", `exit=${result.recoverable ? 2 : 1} code=${result.code} ${result.message}`);
          process.exit(result.recoverable ? 2 : 1);
          break;
      }
      break;
    }

    // [FIX P1] New command: read-only dispatch preview
    case "peek": {
      const projectRoot = resolveRoot(args[0]);
      const result = peek(projectRoot);

      switch (result.type) {
        case "dispatched": {
          console.log(result.prompt);
          const peekMeta = {
            task_name: `${result.story}-${result.step}`,
            project: result.project,
            story: result.story,
            step: result.step,
            attempt: result.attempt,
            fw_lv: result.fw_lv,
          };
          console.log(`\n<task-meta>\n${JSON.stringify(peekMeta, null, 2)}\n</task-meta>`);
          console.error(
            `[peek] Would dispatch: step=${result.step} attempt=${result.attempt}`,
          );
          break;
        }
        case "done":
          console.error(`[peek] DONE: ${result.summary}`);
          break;
        case "needs_human":
          console.error(`[peek] NEEDS HUMAN REVIEW`);
          console.error(result.message);
          break;
        case "blocked":
          console.error(`[peek] BLOCKED: ${result.reason}`);
          break;
        case "already_running":
          console.error(
            `[peek] Already running (${result.elapsed_min} min)`,
          );
          break;
        case "error":
          console.log(JSON.stringify(result, null, 2));
          console.error(`[peek] ERROR (${result.code}): ${result.message}`);
          break;
        case "timeout":
          console.error(
            `[peek] TIMEOUT at ${result.step} (${result.elapsed_min} min)`,
          );
          break;
      }
      break;
    }

    case "apply-handoff": {
      const projectRoot = resolveRoot(args[0]);
      const result = applyHandoff(projectRoot);
      console.log(JSON.stringify(result, null, 2));
      if (result.type === "error") {
        console.error(`[apply-handoff] ERROR (${result.code}): ${result.message}`);
        process.exit(result.recoverable ? 2 : 1);
      }
      if (result.type === "stale") {
        console.error(`[apply-handoff] STALE: ${result.message}`);
      }
      if (result.type === "pending") {
        console.error(`[apply-handoff] PENDING: ${result.message}`);
      }
      if (result.type === "missing") {
        console.error(`[apply-handoff] MISSING: ${result.message}`);
      }
      if (result.type === "applied") {
        const s = result.state;
        console.error(
          `[apply-handoff] Applied → step: ${s.step}, status: ${s.status}, reason: ${s.reason ?? "(none)"}`,
        );
      }
      break;
    }

    case "post-check": {
      const projectRoot = resolveRoot(args[0]);
      const passed = runPostCheck(projectRoot, execSync as any);
      console.log(passed ? "post_check: PASSED" : "post_check: FAILED");
      if (!passed) process.exit(1);
      break;
    }

    case "approve": {
      const projectRoot = resolveRoot(args[0]);
      const note = args[1] || undefined;
      const approveResult = approveReview(projectRoot, note);
      if (approveResult.type === "error") {
        console.log(JSON.stringify(approveResult, null, 2));
        console.error(`[approve] ERROR (${approveResult.code}): ${approveResult.message}`);
        process.exit(1);
      }
      console.log(approveResult.message);
      break;
    }

    case "reject": {
      const projectRoot = resolveRoot(args[0]);
      const reason = args[1];
      if (!reason) {
        console.error(
          "Error: <reason> is required (constitution_violation, needs_clarification, nfr_missing, scope_warning, test_timeout)",
        );
        process.exit(1);
      }
      const note = args[2] || undefined;
      const rejectResult = rejectReview(projectRoot, reason, note);
      if (rejectResult.type === "error") {
        console.log(JSON.stringify(rejectResult, null, 2));
        console.error(`[reject] ERROR (${rejectResult.code}): ${rejectResult.message}`);
        process.exit(1);
      }
      console.log(rejectResult.message);
      break;
    }

    case "status": {
      const projectRoot = resolveRoot(args[0]);
      const state = readState(projectRoot);
      console.log(JSON.stringify(state, null, 2));
      break;
    }

    case "query": {
      const projectRoot = resolveRoot(args[0]);
      const status = queryProjectStatus(projectRoot);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "detect": {
      const projectRoot = resolveRoot(args[0]);
      const result = detectFramework(projectRoot);
      console.log(JSON.stringify(result, null, 2));
      const levelNames = [
        "Not adopted",
        "Partial adoption",
        "Full adoption",
      ];
      console.error(
        `Framework adoption: Level ${result.level} — ${levelNames[result.level]}`,
      );
      break;
    }

    case "list-projects": {
      const workspaceRoot = resolveRoot(args[0]);
      const projects = listProjects(workspaceRoot);
      if (projects.length === 0) {
        console.log("No projects found with .ai/STATE.json");
      } else {
        console.log(JSON.stringify(projects, null, 2));
      }
      break;
    }

    // [v0.6.0] Rollback to a previous step
    case "rollback": {
      const projectRoot = resolveRoot(args[0]);
      const targetStep = args[1];
      if (!targetStep) {
        console.error("Error: <target-step> is required");
        console.error(
          "Example: orchestrator rollback ./project impl",
        );
        process.exit(1);
      }
      const force = args.includes("--force");
      const rollbackResult = rollback(projectRoot, targetStep, { force });
      if (rollbackResult.type === "error") {
        console.log(JSON.stringify(rollbackResult, null, 2));
        console.error(`[rollback] ERROR (${rollbackResult.code}): ${rollbackResult.message}`);
        process.exit(1);
      }
      const rbState = rollbackResult.state;
      console.log(
        `Rolled back to step "${rbState.step}" (status: ${rbState.status}, attempt: ${rbState.attempt})`,
      );
      break;
    }

    // [v0.6.0] Check prerequisite files for current step
    case "check-prereqs": {
      const projectRoot = resolveRoot(args[0]);
      const result = checkPrerequisites(projectRoot);
      if (result.ok) {
        console.log("All prerequisite files present.");
      } else {
        console.log(`Missing ${result.missing.length} prerequisite file(s):`);
        for (const w of result.warnings) {
          console.log(`  ${w}`);
        }
        if (result.suggested_rollback) {
          console.log(
            `Suggested action: orchestrator rollback . ${result.suggested_rollback}`,
          );
        }
      }
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "report-error": {
      const projectRoot = resolveRoot(args[0]);
      const errorMsg = args[1];
      if (!errorMsg) {
        console.error("Error: <error-message> is required");
        console.error(
          'Example: orchestrator report-error . "CC session crashed: output token limit exceeded"',
        );
        process.exit(1);
      }
      const state = readState(projectRoot);
      state.status = "failing";
      state.completed_at = new Date().toISOString();
      state.last_error = errorMsg;
      writeState(projectRoot, state);
      appendLog(projectRoot, "ERROR", "cli:report-error", `step="${state.step}" ${errorMsg}`);
      console.log(`Recorded error for step "${state.step}": ${errorMsg}`);
      break;
    }

    // [v0.8.0] Reopen a completed story at a specific step
    case "reopen": {
      const projectRoot = resolveRoot(args[0]);
      const targetStep = args[1];
      if (!targetStep) {
        console.error("Error: <target-step> is required");
        console.error(
          "Example: orchestrator reopen ./project impl",
        );
        process.exit(1);
      }
      const humanNote = args[2] || undefined;
      const reopenResult = reopen(projectRoot, targetStep, { humanNote });
      if (reopenResult.type === "error") {
        console.log(JSON.stringify(reopenResult, null, 2));
        console.error(`[reopen] ERROR (${reopenResult.code}): ${reopenResult.message}`);
        process.exit(1);
      }
      const reopenState = reopenResult.state;
      console.log(
        `Reopened story "${reopenState.story}" at step "${reopenState.step}" (status: ${reopenState.status}, attempt: ${reopenState.attempt})`,
      );
      break;
    }

    // [v0.8.0] On-demand review session — generate prompt
    case "review": {
      const projectRoot = resolveRoot(args[0]);
      const result = review(projectRoot);
      // Print prompt to stdout (can be piped to claude -p)
      console.log(result.prompt);
      console.error(`[review] Generated review prompt (fw_lv=${result.fw_lv})`);
      appendLog(projectRoot, "INFO", "cli:review", `Generated review session prompt fw_lv=${result.fw_lv}`);
      break;
    }

    // [v0.8.0] Triage ISSUES into action plan
    case "triage": {
      const projectRoot = resolveRoot(args[0]);
      const result = triage(projectRoot);
      if (result.type === "error") {
        console.log(JSON.stringify(result, null, 2));
        console.error(`[triage] ERROR (${result.code}): ${result.message}`);
        process.exit(1);
      }
      // Print prompt to stdout
      console.log(result.prompt);
      console.error(`[triage] Generated triage prompt for ${result.issues.length} issue(s) (fw_lv=${result.fw_lv})`);
      appendLog(projectRoot, "INFO", "cli:triage", `Generated triage prompt for ${result.issues.length} issue(s) fw_lv=${result.fw_lv}`);
      break;
    }

    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      usage();
  }
} catch (err: unknown) {
  // Safety net — ideally never reached after structured error refactor
  const msg = (err as Error).message;
  console.log(JSON.stringify({ type: "error", code: "INTERNAL_ERROR", message: msg }, null, 2));
  console.error(`[INTERNAL] ${msg}`);
  process.exit(127);
}
