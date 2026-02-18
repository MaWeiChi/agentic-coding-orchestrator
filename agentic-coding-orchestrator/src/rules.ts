/**
 * rules.ts — Step Transition Rules Table
 *
 * Pure data, zero logic. Direct translation of the Protocol's Step Transition
 * Rules YAML into TypeScript. The orchestrator looks up this table to decide:
 * what files the executor reads, what it writes, what post-check to run,
 * max attempts, timeout, and where to go on pass/fail.
 *
 * Projects can override defaults via `.ai/step-rules.yaml` (future).
 */

import type { Step, Reason } from "./state";

// ─── Type Definitions ────────────────────────────────────────────────────────

/** Reason-based routing: maps failure reason → target step */
export type FailRouting = {
  /** Fallback when reason is null or unrecognized */
  default: Step;
} & Partial<Record<Reason, Step>>;

/** Complete rule definition for a single step */
export interface StepRule {
  /** Display name for dispatch prompt */
  display_name: string;

  /** Step to advance to on success */
  next_on_pass: Step;

  /** Reason-based routing on failure */
  on_fail: FailRouting;

  /** Maximum attempts before marking as blocked */
  max_attempts: number;

  /** Timeout in minutes for executor session */
  timeout_min: number;

  /** Whether this step requires human input (pauses pipeline) */
  requires_human: boolean;

  /** Files executor should read at this step.
   *  Supports {story} placeholder for current Story ID. */
  claude_reads: string[];

  /** Files/patterns executor may write at this step */
  claude_writes: string[];

  /** Shell command to run after executor exits (null = none).
   *  Deterministic check, zero LLM tokens. */
  post_check: string | null;

  /** Fixed instruction for the dispatch prompt */
  step_instruction: string;
}

/** Role definition for multi-executor team dispatch */
export interface TeamRole {
  claude_reads: string[];
  claude_writes: string[];
}

/** Optional team_roles extension for multi-executor steps */
export type TeamRoles = Record<string, TeamRole>;

/** Dispatch mode based on story complexity */
export type DispatchMode = "single" | "auto" | "team";

/** Complexity-to-dispatch-mode mapping */
export const DISPATCH_MODES: Record<string, DispatchMode> = {
  S: "single",
  M: "auto", // check [P] count, enable team only if ≥ 2
  L: "team",
};

// ─── Step Rules Table ────────────────────────────────────────────────────────

export const STEP_RULES: Record<Exclude<Step, "bootstrap" | "done">, StepRule> = {
  bdd: {
    display_name: "BDD Scenario Writing",
    next_on_pass: "sdd-delta",
    on_fail: { default: "bdd" },
    max_attempts: 3,
    timeout_min: 5,
    requires_human: false,
    claude_reads: [
      "PROJECT_CONTEXT.md",
      "PROJECT_MEMORY.md",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["docs/bdd/US-{story}.md"],
    post_check: null,
    step_instruction:
      "Based on MEMORY's NOW/NEXT, write BDD scenarios for this Story. " +
      "Use RFC 2119 language, tag test levels (@unit, @integration, @component, @e2e, @perf(ID)). " +
      "Mark unclear items [NEEDS CLARIFICATION]. " +
      "Include Non-Goals section.",
  },

  "sdd-delta": {
    display_name: "SDD Delta Spec",
    next_on_pass: "contract",
    on_fail: { default: "sdd-delta" },
    max_attempts: 3,
    timeout_min: 5,
    requires_human: false,
    claude_reads: [
      "PROJECT_CONTEXT.md",
      "PROJECT_MEMORY.md",
      "docs/bdd/US-{story}.md",
      "docs/sdd.md",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["docs/deltas/US-{story}.md"],
    post_check: null,
    step_instruction:
      "Based on BDD scenarios, analyze affected modules, produce Delta Spec " +
      "(ADDED / MODIFIED / REMOVED). Include Non-Goals / Out of Scope section. " +
      "Never rewrite the entire SDD.",
  },

  contract: {
    display_name: "API Contract Update",
    next_on_pass: "review",
    on_fail: { default: "contract" },
    max_attempts: 2,
    timeout_min: 5,
    requires_human: false,
    claude_reads: [
      "docs/sdd.md",
      "docs/deltas/US-{story}.md",
      "docs/api/openapi.yaml",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["docs/api/openapi.yaml"],
    post_check: null,
    step_instruction:
      "Based on Delta Spec, update affected endpoints/events in OpenAPI/AsyncAPI contracts. " +
      "Only add or modify affected parts; don't rewrite the entire contract.",
  },

  review: {
    display_name: "Review Checkpoint",
    next_on_pass: "scaffold",
    on_fail: {
      default: "bdd",
      needs_clarification: "bdd",
      constitution_violation: "sdd-delta",
      scope_warning: "sdd-delta",
    },
    max_attempts: 1,
    timeout_min: 0, // human-paced, no timeout
    requires_human: true,
    claude_reads: [],
    claude_writes: [],
    post_check: null,
    step_instruction: "", // not dispatched to executor
  },

  scaffold: {
    display_name: "Test Scaffolding",
    next_on_pass: "impl",
    on_fail: { default: "scaffold" },
    max_attempts: 2,
    timeout_min: 5,
    requires_human: false,
    claude_reads: [
      "docs/bdd/US-{story}.md",
      "docs/nfr.md",
      "docs/api/openapi.yaml",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["*_test.go", "*.spec.ts"],
    post_check: null,  // Project-specific: configure via .ai/step-rules.yaml
    step_instruction:
      "Based on BDD scenario tags and NFR table, produce corresponding test " +
      "skeleton. All tests must fail (red). Use require for Given (preconditions), " +
      "assert for Then (verification). Use Table-Driven tests for Scenario Outlines.",
  },

  impl: {
    display_name: "Implementation",
    next_on_pass: "verify",
    on_fail: {
      default: "impl",
      constitution_violation: "sdd-delta",
      needs_clarification: "review",
      scope_warning: "review",
    },
    max_attempts: 5,
    timeout_min: 10,
    requires_human: false,
    claude_reads: [
      "docs/bdd/US-{story}.md",
      "docs/sdd.md",
      "docs/api/openapi.yaml",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["*.go", "*.ts", "*.tsx"],
    post_check: null,  // Project-specific: configure via .ai/step-rules.yaml
    step_instruction:
      "Read failing tests, write minimal code to make tests pass, then refactor. " +
      "Only modify affected files and functions (Diff-Only principle). " +
      "Don't refactor unrelated code.",
  },

  verify: {
    display_name: "Verify (Quality Gate)",
    next_on_pass: "update-memory",
    on_fail: { default: "impl" },
    max_attempts: 2,
    timeout_min: 5,
    requires_human: false,
    claude_reads: [
      "docs/bdd/US-{story}.md",
      "docs/deltas/US-{story}.md",
      "docs/sdd.md",
      "docs/api/openapi.yaml",
      "docs/constitution.md",
      ".ai/HANDOFF.md",
    ],
    claude_writes: [],
    post_check: null,
    step_instruction:
      "Execute triple check: " +
      "Completeness (all BDD scenarios have tests, all Delta items implemented), " +
      "Correctness (tests pass, NFR thresholds met), " +
      "Coherence (SDD merged Delta, contracts consistent, Constitution not violated). " +
      "Merge Delta Spec into main SDD after all checks pass.",
  },

  "update-memory": {
    display_name: "Update Memory",
    next_on_pass: "done",
    on_fail: { default: "update-memory" },
    max_attempts: 2,
    timeout_min: 3,
    requires_human: false,
    claude_reads: ["PROJECT_MEMORY.md", ".ai/HANDOFF.md"],
    claude_writes: ["PROJECT_MEMORY.md", ".ai/history.md"],
    post_check: null,
    step_instruction:
      "Update MEMORY's NOW/NEXT based on completed work. " +
      "Append DONE + LOG entry to .ai/history.md (session archive). " +
      "Overwrite .ai/HANDOFF.md with latest session summary. " +
      "Record current git commit hash.",
  },

  custom: {
    display_name: "Custom Task",
    next_on_pass: "update-memory",
    on_fail: { default: "custom" },
    max_attempts: 3,
    timeout_min: 15,
    requires_human: false,
    claude_reads: [
      "PROJECT_CONTEXT.md",
      "PROJECT_MEMORY.md",
      "docs/sdd.md",
      "docs/constitution.md",
      ".ai/HANDOFF.md",
    ],
    claude_writes: ["*"],
    post_check: null,
    step_instruction:
      "Execute the custom task described in the Human Instruction section above. " +
      "Follow the project's Constitution constraints. " +
      "Only modify files relevant to the task — don't refactor unrelated code. " +
      "If the task is unclear, fill reason with needs_clarification.",
  },
};

// ─── Custom Task Use Cases ──────────────────────────────────────────────────
//
// The "custom" step is a generic passthrough that lets OpenClaw forward ANY
// instruction to Claude Code with full project context. Common use cases:
//
// ── Refactoring ──
//   "Extract authentication logic into a separate auth module"
//   "Rename all UserDTO references to UserResponse"
//   "Convert class components to functional components with hooks"
//   "Split monolithic service.ts into domain-specific modules"
//
// ── Code Review ──
//   "Review src/api/ for security vulnerabilities"
//   "Review PR #42 changes and list potential issues"
//   "Check all error handling paths in the payment flow"
//   "Audit dependencies for known CVEs"
//
// ── Bug Fix (hotfix, not full story) ──
//   "Fix the race condition in WebSocket reconnection"
//   "Debug why /api/users returns 500 on empty query"
//   "Fix memory leak in event listener cleanup"
//
// ── DevOps / Infrastructure ──
//   "Add GitHub Actions CI pipeline for lint + test + build"
//   "Create Dockerfile and docker-compose.yml for local dev"
//   "Set up pre-commit hooks for linting and formatting"
//   "Configure Renovate for automated dependency updates"
//
// ── Documentation ──
//   "Add JSDoc comments to all exported functions in src/api/"
//   "Update README with current API endpoints and examples"
//   "Generate OpenAPI spec from existing route handlers"
//   "Write architecture decision record for database choice"
//
// ── Testing ──
//   "Add unit tests for utils/validation.ts (target 90% coverage)"
//   "Write integration tests for the checkout flow"
//   "Add snapshot tests for all React components in src/ui/"
//   "Set up E2E tests with Playwright for critical user paths"
//
// ── Dependency / Migration ──
//   "Upgrade React from v17 to v18, fix breaking changes"
//   "Migrate from Express to Fastify"
//   "Replace moment.js with date-fns"
//   "Migrate database schema: add soft delete to all entities"
//
// ── Performance ──
//   "Profile and optimize the dashboard query (currently 3s)"
//   "Add Redis caching for /api/products endpoint"
//   "Implement virtual scrolling for the transaction list"
//   "Lazy-load all route components with React.lazy"
//
// ── Security ──
//   "Add rate limiting to all authentication endpoints"
//   "Implement CSRF protection for form submissions"
//   "Sanitize all user inputs in the search endpoint"
//   "Add Content-Security-Policy headers"
//
// ── Cleanup ──
//   "Remove all unused imports and dead code"
//   "Standardize error response format across all endpoints"
//   "Replace console.log with structured logger"
//   "Fix all TypeScript strict mode errors"
//

// ─── Bootstrap Rule (special: one-time, not in the micro-waterfall loop) ─────

export const BOOTSTRAP_RULE: StepRule = {
  display_name: "Bootstrap",
  next_on_pass: "bdd",
  on_fail: { default: "bootstrap" },
  max_attempts: 1,
  timeout_min: 10,
  requires_human: false,
  claude_reads: [],
  claude_writes: [
    "PROJECT_CONTEXT.md",
    "docs/sdd.md",
    "docs/constitution.md",
    "PROJECT_MEMORY.md",
  ],
  post_check: null,
  step_instruction:
    "Set up the project using the Agentic Coding Framework. Produce: " +
    "PROJECT_CONTEXT.md (Why/Who/What + tech stack + project structure), " +
    "docs/sdd.md (module division + data model skeleton + inter-module interfaces), " +
    "docs/constitution.md (3-5 inviolable architectural principles), " +
    "PROJECT_MEMORY.md (initial state). " +
    "Create directory structure: docs/bdd/, docs/deltas/, docs/api/, docs/ddd/ (if multi-domain).",
};

// ─── Team Roles (Multi-Executor, optional) ───────────────────────────────────

export const DEFAULT_TEAM_ROLES: Record<string, TeamRoles> = {
  impl: {
    backend: {
      claude_reads: [
        "docs/sdd.md",
        "docs/api/openapi.yaml",
        "internal/**/*.go",
      ],
      claude_writes: ["*.go"],
    },
    frontend: {
      claude_reads: ["docs/api/openapi.yaml", "src/components/**"],
      claude_writes: ["*.ts", "*.tsx"],
    },
    test: {
      claude_reads: [
        "docs/bdd/US-{story}.md",
        "docs/api/openapi.yaml",
        "docs/nfr.md",
      ],
      claude_writes: ["*_test.go", "*.spec.ts"],
    },
    verify: {
      claude_reads: [
        "docs/bdd/US-{story}.md",
        "docs/deltas/US-{story}.md",
        "docs/api/openapi.yaml",
        "docs/constitution.md",
      ],
      claude_writes: [],
    },
  },
};

// ─── Lookup Helpers ──────────────────────────────────────────────────────────

/** Get the rule for a given step */
export function getRule(step: Step): StepRule {
  if (step === "bootstrap") return BOOTSTRAP_RULE;
  if (step === "done") throw new Error('No rule for "done" — story is complete');
  return STEP_RULES[step];
}

/** Resolve {story} placeholders in file paths */
export function resolvePaths(paths: string[], storyId: string): string[] {
  return paths.map((p) => p.replace(/\{story\}/g, storyId));
}

/** Determine dispatch mode from complexity marker */
export function getDispatchMode(
  complexity: string,
  parallelCount: number = 0
): DispatchMode {
  const mode = DISPATCH_MODES[complexity] ?? "single";
  if (mode === "auto") {
    return parallelCount >= 2 ? "team" : "single";
  }
  return mode;
}

/** Get the next step after a failure, using reason-based routing */
export function getFailTarget(step: Step, reason: Reason | null): Step {
  const rule = getRule(step);
  if (reason && rule.on_fail[reason]) {
    return rule.on_fail[reason]!;
  }
  return rule.on_fail.default;
}

/** Get ordered step sequence for the micro-waterfall loop */
export function getStepSequence(): Step[] {
  return [
    "bdd",
    "sdd-delta",
    "contract",
    "review",
    "scaffold",
    "impl",
    "verify",
    "update-memory",
  ];
}
