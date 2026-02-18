#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for the Agentic Coding Orchestrator
 *
 * Commands:
 *   init <project-root> <project-name>          Initialize .ai/STATE.json
 *   start-story <project-root> <story-id>       Begin a new User Story (micro-waterfall)
 *   start-custom <project-root> <instruction>   Begin a custom ad-hoc task
 *   dispatch <project-root>                     Dispatch next step (prints prompt)
 *   apply-handoff <project-root>                Parse HANDOFF.md → update STATE
 *   approve <project-root> [note]               Approve review step
 *   reject <project-root> <reason> [note]       Reject review step
 *   status <project-root>                       Print current STATE.json
 */

import { resolve } from "path";
import { execSync } from "child_process";

import { initState, readState } from "./state";
import { dispatch, applyHandoff, runPostCheck, approveReview, rejectReview, startStory, startCustom, queryProjectStatus, detectFramework, listProjects } from "./dispatch";
import type { Reason } from "./state";

const [, , command, ...args] = process.argv;

function usage(): never {
  console.error(`Usage: orchestrator <command> [args]

Commands:
  init <project-root> <project-name>              Initialize .ai/STATE.json
  start-story <project-root> <story-id>           Begin a new User Story (micro-waterfall)
  start-custom <project-root> <instruction>       Begin a custom ad-hoc task
  dispatch <project-root>                         Dispatch next step (prints prompt to stdout)
  apply-handoff <project-root>           Parse HANDOFF.md → update STATE.json
  post-check <project-root>              Run step's post_check command
  approve <project-root> [note]          Approve review step
  reject <project-root> <reason> [note]  Reject review step
  status <project-root>                  Print current STATE.json
  query <project-root>                   Project status summary (for OpenClaw)
  detect <project-root>                  Check if project uses the framework
  list-projects <workspace-root>         List all projects in workspace
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
        console.log(`STATE.json already exists (step: ${state.step}, status: ${state.status})`);
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
      const state = startStory(projectRoot, storyId);
      console.log(`Started story ${storyId} (step: ${state.step}, attempt: ${state.attempt})`);
      break;
    }

    case "start-custom": {
      const projectRoot = resolveRoot(args[0]);
      const instruction = args[1];
      if (!instruction) {
        console.error("Error: <instruction> is required");
        console.error('Example: orchestrator start-custom ./project "Refactor auth module into separate package"');
        process.exit(1);
      }
      const label = args[2] || undefined; // optional label
      const agentTeams = args[3] === "--agent-teams";
      const state = startCustom(projectRoot, instruction, { label, agentTeams });
      console.log(`Started custom task: "${instruction}"`);
      console.log(`  label: ${state.story}, step: ${state.step}, task_type: ${state.task_type}`);
      break;
    }

    case "dispatch": {
      const projectRoot = resolveRoot(args[0]);
      const result = dispatch(projectRoot);

      switch (result.type) {
        case "dispatched":
          // Print prompt to stdout (can be piped to claude -p)
          console.log(result.prompt);
          // Print metadata to stderr so it doesn't pollute prompt
          console.error(`[dispatch] step=${result.step} attempt=${result.attempt}`);
          break;
        case "done":
          console.error(`[dispatch] DONE: ${result.summary}`);
          break;
        case "needs_human":
          console.error(`[dispatch] NEEDS HUMAN REVIEW`);
          console.error(result.message);
          break;
        case "blocked":
          console.error(`[dispatch] BLOCKED: ${result.reason}`);
          process.exit(1);
          break;
        case "already_running":
          console.error(`[dispatch] Already running (${result.elapsed_min} min)`);
          break;
        case "timeout":
          console.error(`[dispatch] TIMEOUT at ${result.step} (${result.elapsed_min} min)`);
          process.exit(1);
          break;
      }
      break;
    }

    case "apply-handoff": {
      const projectRoot = resolveRoot(args[0]);
      const state = applyHandoff(projectRoot);
      console.log(`Applied HANDOFF → step: ${state.step}, status: ${state.status}, reason: ${state.reason ?? "(none)"}`);
      if (state.tests) {
        console.log(`  tests: pass=${state.tests.pass} fail=${state.tests.fail} skip=${state.tests.skip}`);
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
      approveReview(projectRoot, note);
      console.log(`Review approved${note ? ` (note: "${note}")` : ""}`);
      break;
    }

    case "reject": {
      const projectRoot = resolveRoot(args[0]);
      const reason = args[1] as Reason;
      if (!reason) {
        console.error("Error: <reason> is required (constitution_violation, needs_clarification, nfr_missing, scope_warning, test_timeout)");
        process.exit(1);
      }
      const note = args[2] || undefined;
      rejectReview(projectRoot, reason, note);
      console.log(`Review rejected (reason: ${reason}${note ? `, note: "${note}"` : ""})`);
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
      const levelNames = ["Not adopted", "Partial adoption", "Full adoption"];
      console.error(`Framework adoption: Level ${result.level} — ${levelNames[result.level]}`);
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

    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      usage();
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
