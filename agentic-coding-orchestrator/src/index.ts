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
  type State,
  type Step,
  type Status,
  type Reason,
  type TaskType,
  type TestResult,
  createInitialState,
  readState,
  writeState,
  initState,
  validate,
  isTimedOut,
  isMaxedOut,
  markRunning,
  markCompleted,
} from "./state";

// Rules
export {
  type StepRule,
  type FailRouting,
  type TeamRole,
  type TeamRoles,
  type DispatchMode,
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

// Dispatch
export {
  type DispatchResult,
  type HandoffResult,
  dispatch,
  buildPrompt,
  parseHandoff,
  applyHandoff,
  runPostCheck,
  approveReview,
  rejectReview,
  startStory,
  startCustom,
} from "./dispatch";
