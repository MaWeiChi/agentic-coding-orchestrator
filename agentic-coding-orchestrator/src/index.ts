/**
 * Agentic Coding Protocol — Orchestrator Core
 *
 * Three modules, one pipeline:
 *   state.ts   → STATE.json types + I/O
 *   rules.ts   → Step transition rules table (pure data)
 *   dispatch.ts → State machine + prompt builder + handoff parser
 */

// State
export {
  createInitialState,
  readState,
  writeState,
  initState,
  validate,
  sanitize,
  isTimedOut,
  isMaxedOut,
  markRunning,
  markCompleted,
  generateClaudeMd,
  writeClaudeMd,
} from "./state";
export type { State, TestResults } from "./state";

// Rules
export {
  STEP_RULES,
  BOOTSTRAP_RULE,
  DEFAULT_TEAM_ROLES,
  DISPATCH_MODES,
  getRule,
  resolvePaths,
  getDispatchMode,
  getFailTarget,
  getStepSequence,
} from "./rules";
export type { StepRule } from "./rules";

// Auto (unified entry point)
export { auto, classify } from "./auto";

// Dispatch
export {
  dispatch,
  peek, // [FIX P1] New: read-only dispatch preview
  buildPrompt,
  parseHandoff,
  applyHandoff,
  runPostCheck,
  approveReview,
  rejectReview,
  startStory,
  startCustom,
  detectFramework,
  queryProjectStatus,
  listProjects,
  rollback, // [v0.6.0] Rollback to previous step
  checkPrerequisites, // [v0.6.0] Pre-dispatch file checks
  generateChecklist, // [v0.6.0] Per-story checklist generation
  reopen, // [v0.8.0] Reopen completed story at step
  review, // [v0.8.0] On-demand review session prompt
  triage, // [v0.8.0] Triage ISSUES into action plan
} from "./dispatch";
export type { DispatchResult, HandoffData, PrereqCheckResult } from "./dispatch";
