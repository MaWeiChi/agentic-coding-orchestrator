# OpenClaw Orchestrator — Protocol Reference

This reference maps the Agentic Coding Protocol concepts to the actual TypeScript
implementation in `agentic-coding-openclaw/src/`. Use this when configuring,
extending, or debugging the orchestrator pipeline.

---

## Module Architecture

```
index.ts            ← Unified public API
  ├── state.ts      ← STATE.json types, read/write, validation, helpers
  ├── rules.ts      ← Step transition rules table (pure data, zero logic)
  └── dispatch.ts   ← State machine, prompt builder, HANDOFF parser, hooks
```

All orchestrator decisions are **deterministic code — zero LLM tokens**. The executor
(Claude Code) bears the token cost. The orchestrator only does: read JSON, look up
table, fill template, write JSON.

---

## state.ts — STATE.json Management

### Core Types

```typescript
type Step =
  | "bootstrap" | "bdd" | "sdd-delta" | "contract" | "review"
  | "scaffold" | "impl" | "verify" | "update-memory" | "done";

type Status =
  | "pending" | "running" | "pass" | "failing" | "needs_human" | "timeout";

type Reason =
  | "constitution_violation" | "needs_clarification"
  | "nfr_missing" | "scope_warning" | "test_timeout";

interface State {
  project: string;
  story: string | null;
  step: Step;
  attempt: number;
  max_attempts: number;
  status: Status;
  reason: Reason | null;
  dispatched_at: string | null;    // ISO 8601
  completed_at: string | null;     // ISO 8601
  timeout_min: number;
  tests: { pass: number; fail: number; skip: number } | null;
  failing_tests: string[];
  lint_pass: boolean | null;
  files_changed: string[];
  blocked_by: string[];
  human_note: string | null;
}
```

### Key Functions

| Function | Purpose | Side Effects |
|----------|---------|-------------|
| `initState(projectRoot, projectName)` | Create `.ai/STATE.json` if missing | Writes file; no-op if exists |
| `readState(projectRoot)` | Read + validate STATE.json | Throws if missing or invalid |
| `writeState(projectRoot, state)` | Write STATE.json (creates `.ai/` dir if needed) | Validates before writing |
| `validate(state)` | Check all fields against valid enums | Throws on invalid |
| `isTimedOut(state)` | Check if running step exceeded timeout_min | Pure, no side effects |
| `isMaxedOut(state)` | Check if attempt >= max_attempts | Pure, no side effects |
| `markRunning(state)` | Return new state with status=running, timestamp set | Immutable (returns copy) |
| `markCompleted(state, status, reason?)` | Return new state with completion info | Immutable (returns copy) |

### Status State Machine

```
pending → running → pass      → (dispatch advances to next step)
                  → failing   → (dispatch retries or routes by reason)
                  → timeout   → (notify human)
                  → needs_human → (wait for human)
```

### File Layout

```
{project_root}/.ai/STATE.json
```

---

## rules.ts — Step Transition Rules Table

### StepRule Interface

```typescript
interface StepRule {
  display_name: string;        // For dispatch prompt header
  next_on_pass: Step;          // Where to go on success
  on_fail: FailRouting;        // Reason-based routing on failure
  max_attempts: number;        // Before marking blocked
  timeout_min: number;         // Executor session timeout
  requires_human: boolean;     // Pauses pipeline for human input
  claude_reads: string[];      // Files executor should read ({story} placeholder)
  claude_writes: string[];     // Files/patterns executor may produce
  post_check: string | null;   // Shell command after executor exits
  step_instruction: string;    // Fixed text for dispatch prompt
}
```

### Step Chain (next_on_pass)

```
bootstrap → bdd → sdd-delta → contract → review → scaffold → impl → verify → update-memory → done
```

### Reason-Based Routing (on_fail)

When executor reports a reason in HANDOFF.md, the orchestrator routes to a different
step instead of retrying blindly:

| Step | Reason | Routes To | Why |
|------|--------|-----------|-----|
| impl | `null` (general) | impl (retry) | Normal retry |
| impl | `constitution_violation` | sdd-delta | Architecture problem → redesign |
| impl | `needs_clarification` | review | Ambiguous spec → ask human |
| impl | `scope_warning` | review | Touched Non-Goals → confirm |
| review | `needs_clarification` | bdd | Rewrite scenarios |
| review | `constitution_violation` | sdd-delta | Redesign needed |
| review | `scope_warning` | sdd-delta | Adjust scope |

For steps not listed (bdd, sdd-delta, contract, scaffold, verify, update-memory),
`on_fail.default` points back to themselves (simple retry).

### Key Functions

| Function | Purpose |
|----------|---------|
| `getRule(step)` | Lookup rule by step name (throws for "done") |
| `resolvePaths(paths, storyId)` | Replace `{story}` placeholders |
| `getFailTarget(step, reason)` | Get target step after failure |
| `getDispatchMode(complexity, parallelCount)` | S→single, M→auto, L→team |
| `getStepSequence()` | Return ordered step array (8 steps) |

### Complexity-Based Dispatch

```typescript
const DISPATCH_MODES = { S: "single", M: "auto", L: "team" };
// "auto" checks [P] count: ≥2 parallel tags → team, else single
```

### Multi-Executor Team Roles (Optional)

```typescript
DEFAULT_TEAM_ROLES.impl = {
  backend:  { claude_reads: ["docs/sdd/sdd.md", "docs/api/openapi.yaml", "internal/**/*.go"],
              claude_writes: ["*.go"] },
  frontend: { claude_reads: ["docs/api/openapi.yaml", "src/components/**"],
              claude_writes: ["*.ts", "*.tsx"] },
  test:     { claude_reads: ["docs/bdd/US-{story}.md", "docs/api/openapi.yaml", "docs/nfr.md"],
              claude_writes: ["*_test.go", "*.spec.ts"] },
  verify:   { claude_reads: ["docs/bdd/US-{story}.md", "docs/deltas/US-{story}.md",
                              "docs/api/openapi.yaml", "docs/constitution.md"],
              claude_writes: [] },
};
```

---

## dispatch.ts — State Machine + Prompt Builder + HANDOFF Parser

### dispatch(projectRoot): DispatchResult

The main entry point. Reads STATE.json, applies rules, returns what to do next.

```typescript
type DispatchResult =
  | { type: "dispatched"; step: Step; attempt: number; prompt: string }
  | { type: "blocked"; step: Step; reason: string }
  | { type: "needs_human"; step: Step; message: string }
  | { type: "done"; story: string; summary: string }
  | { type: "already_running"; step: Step; elapsed_min: number }
  | { type: "timeout"; step: Step; elapsed_min: number };
```

### Decision Flow

```
dispatch(projectRoot)
  │
  ├─ step === "done" ──────────────────→ return { type: "done" }
  │
  ├─ status === "running"
  │   ├─ timed out? ───────────────────→ mark timeout, return { type: "timeout" }
  │   └─ still running ───────────────→ return { type: "already_running" }
  │
  ├─ requires_human && status !== "pass"
  │   └──────────────────────────────→ return { type: "needs_human" }
  │
  ├─ status === "pass"
  │   ├─ advance step (next_on_pass)
  │   ├─ new step is "done"? ─────────→ return { type: "done" }
  │   ├─ new step requires_human? ────→ return { type: "needs_human" }
  │   └─ continue to dispatch ─────────→ ↓
  │
  ├─ status === "failing"
  │   ├─ maxed out? ──────────────────→ return { type: "blocked" }
  │   ├─ reason routes to different step? → reset attempt to 1
  │   └─ same step? → attempt++
  │
  └─ Build prompt, mark running, write STATE
     └──────────────────────────────→ return { type: "dispatched", prompt }
```

### buildPrompt(state, rule): string

Template filling — zero LLM. Assembles:

1. **Header**: step display name + story ID
2. **Attempt info**: "(Attempt N of M)" if retry
3. **claude_reads**: file list with {story} resolved
4. **human_note**: if present, wrapped in `=== Human Instruction ===`
5. **Failing tests**: from previous attempt (if retry)
6. **Test results injection**: for `update-memory` step, injects pass/fail/skip counts and
   files_changed from STATE.json directly into the prompt (executor never reads STATE.json)
7. **step_instruction**: fixed per-step instruction from rules
8. **Output rules**: always appended — HANDOFF.md format requirements

### parseHandoff(projectRoot): HandoffResult | null

Reads `.ai/HANDOFF.md` and extracts structured data:

**Primary path (YAML front matter):**
```markdown
---
story: US-005
step: impl
attempt: 2
status: failing
reason: null
files_changed:
  - internal/cart/service.go
tests_pass: 42
tests_fail: 2
tests_skip: 1
---

# HANDOFF body...
```

**Fallback path (old format):** Greps for keywords `NEEDS CLARIFICATION`,
`CONSTITUTION VIOLATION`, `SCOPE WARNING` in markdown body.

```typescript
interface HandoffResult {
  story: string | null;
  step: string | null;
  attempt: number | null;
  status: Status | null;
  reason: Reason | null;
  files_changed: string[];
  tests_pass: number | null;
  tests_fail: number | null;
  tests_skip: number | null;
  body: string;              // markdown body (after ---)
}
```

### applyHandoff(projectRoot): State

Post-hook equivalent. Call after executor exits:

1. Read HANDOFF.md via `parseHandoff()`
2. If no HANDOFF → mark `failing` (executor crashed)
3. Apply structured fields (status, reason, tests, files_changed) to STATE.json
4. Write updated STATE.json

### Other Functions

| Function | Purpose |
|----------|---------|
| `runPostCheck(projectRoot, execSync)` | Run `post_check` shell command, update `lint_pass` |
| `approveReview(projectRoot, note?)` | Mark review as pass (human approved) |
| `rejectReview(projectRoot, reason, note?)` | Mark review as failing with reason |
| `startStory(projectRoot, storyId)` | Reset state for new story (step=bdd, attempt=1) |

---

## Integration: Orchestrator Main Loop

The three modules compose into a simple main loop. Here's the pattern for any
orchestrator (OpenClaw, CLI tool, Telegram bot, etc.):

```typescript
import {
  initState, readState,
  dispatch, applyHandoff, runPostCheck,
  approveReview, startStory,
} from "@agentic-coding/openclaw-core";
import { execSync } from "child_process";

// 1. Initialize
initState(projectRoot, "my-app");
startStory(projectRoot, "US-001");

// 2. Main loop
while (true) {
  const result = dispatch(projectRoot);

  switch (result.type) {
    case "dispatched":
      // Spawn executor (Claude Code CLI, API call, etc.)
      spawnExecutor(projectRoot, result.prompt);
      // Wait for executor to exit...
      // Run post-check
      runPostCheck(projectRoot, execSync);
      // Apply HANDOFF results to STATE
      applyHandoff(projectRoot);
      break;

    case "needs_human":
      // Notify human via communication channel
      notifyHuman(result.message);
      // Wait for human response...
      // Then: approveReview(projectRoot) or rejectReview(projectRoot, reason)
      waitForHumanThenApply(projectRoot);
      break;

    case "blocked":
      notifyHuman(`Blocked: ${result.reason}`);
      return; // Or wait for human intervention

    case "done":
      notifyHuman(`Story complete: ${result.summary}`);
      // Start next story or exit
      return;

    case "already_running":
      notifyHuman(`Still running (${result.elapsed_min} min)`);
      return;

    case "timeout":
      notifyHuman(`Timed out at ${result.step} (${result.elapsed_min} min)`);
      break; // Next dispatch() will handle retry
  }
}
```

### Level 0 → Level 1 → Level 2

| Level | Who calls dispatch()? | Who spawns executor? |
|-------|----------------------|---------------------|
| **0** (manual) | Not used — human tells executor directly | Human |
| **1** (semi-auto) | Human says "continue" → triggers dispatch() | Script spawns executor, human triggers |
| **2** (fully auto) | Orchestrator auto-calls dispatch() in loop | Orchestrator spawns + monitors |

At Level 0, you don't need this code at all — the executor just reads project files
and follows the framework. At Level 1, `dispatch()` + `applyHandoff()` replace the
"remember where I was" burden. At Level 2, the full loop above runs autonomously.

---

## Three-File Protocol Summary

| File | Location | Writer | Reader | Format |
|------|----------|--------|--------|--------|
| STATE.json | `.ai/STATE.json` | Orchestrator + hooks | Orchestrator | JSON (machine-parsed) |
| HANDOFF.md | `.ai/HANDOFF.md` | Executor | Orchestrator hooks + next executor | YAML front matter + Markdown body |
| PROJECT_MEMORY.md | Project root | Executor | Any session startup | Markdown (human-readable) |

The orchestrator **never touches PROJECT_MEMORY.md**. The executor **never touches STATE.json**.
HANDOFF.md is the bridge — executor writes it, hooks parse the YAML front matter to
update STATE.json.

---

## Extending: Custom Step Rules

Projects can override defaults by modifying the rules table. Common customizations:

```typescript
import { STEP_RULES } from "@agentic-coding/openclaw-core";

// Frontend project: change post_check
STEP_RULES.impl.post_check = "eslint . && tsc --noEmit";
STEP_RULES.scaffold.post_check = "tsc --noEmit";

// Simple CRUD project: reduce attempts
STEP_RULES.impl.max_attempts = 3;

// High-security project: add security scan to verify
STEP_RULES.verify.post_check = "npm run security-scan";

// Add custom claude_reads for a step
STEP_RULES.impl.claude_reads.push("docs/security-policy.md");
```

Future: load overrides from `.ai/step-rules.yaml` per project.

---

## Extending: Multi-Executor Team Dispatch

For `[M]+[P]` or `[L]` stories, the orchestrator spawns a Story-Level Coordinator
instead of a single executor:

```
Orchestrator
  └── dispatch() → result.type === "dispatched"
      └── Check getDispatchMode(complexity, parallelCount)
          ├── "single" → spawn one executor with result.prompt
          └── "team"   → spawn coordinator with team prompt
                         Coordinator reads DEFAULT_TEAM_ROLES[step]
                         Coordinator spawns scoped executors per role
                         Coordinator writes consolidated HANDOFF.md
```

The coordinator's consolidated HANDOFF.md follows this format:

```markdown
---
story: US-007
step: impl
attempt: 1
status: pass
reason: null
files_changed:
  - internal/coupon/repository.go
  - src/components/CouponInput.tsx
tests_pass: 28
tests_fail: 0
tests_skip: 0
---

# HANDOFF — US-007 impl (multi-executor)

## Executor Progress
- backend: ✅ CouponRepository + DiscountEngine done
- frontend: ✅ Coupon component done
- test: ✅ unit tests pass

## File Conflict Log
- None

## Next session notes
- Integration test ready to run in verify step
```

`applyHandoff()` parses this identically — it doesn't care whether one or many
executors produced the HANDOFF.
