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
} from "./dispatch";
export type { DispatchResult, HandoffData } from "./dispatch";
