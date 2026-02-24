# Orchestrator Fixes

Bug fixes for `@agentic-coding-framework/orchestrator-core@0.2.0`.

## P0 — `{story}` Path Double-Prefix

**File**: `src/rules.ts` (`resolvePaths()`)

**Bug**: Templates use `"docs/bdd/US-{story}.md"` but `storyId` is already `"US-013"`,
producing `"docs/bdd/US-US-013.md"`.

**Root Cause**: Convention mismatch — templates assume bare numeric IDs but CLI passes
full `US-XXX` identifiers.

**Fix**: Smart replacement in `resolvePaths()` — if template contains `US-{story}` and
storyId already starts with `US-`, replace `US-{story}` as a whole unit with storyId.
This handles both `"US-013"` (full) and `"013"` (bare) correctly.

**Impact**: All file read/write paths in BDD, SDD Delta, Scaffold, Impl, Verify steps
were broken when using standard `US-XXX` story IDs.

---

## P1 — `dispatch()` Has No Read-Only Mode

**File**: `src/dispatch.ts` (new `peek()` function)

**Bug**: Every call to `dispatch()` marks STATE as `running` with a new `dispatched_at`
timestamp. There's no way to inspect what the next dispatch would do without mutating state.

**Root Cause**: `dispatch()` combines state inspection and state mutation in one function.

**Fix**: Added `peek(projectRoot)` function that returns the same `DispatchResult` but
never writes to STATE.json. Useful for:
- `dispatch-claude-code.sh` checking if dispatch is needed before committing
- Debugging / monitoring without contaminating state
- OpenClaw dry-run checks

**CLI**: Added `orchestrator peek <project-root>` command.

---

## P1 — Timeout Exit Code Breaks Dispatch Chain

**File**: `src/cli.ts`

**Bug**: `timeout` and `blocked` cases call `process.exit(1)`, which causes
`dispatch-claude-code.sh` to abort (due to `set -e`), preventing the auto-advance
retry logic from running.

**Fix**: Changed both to `process.exit(0)` — these are expected orchestrator states,
not errors. The dispatch script can check stdout content to determine next action.

---

## P2 — `parseSimpleYaml` Colon-in-Value Bug

**File**: `src/dispatch.ts` (`parseSimpleYaml()`)

**Bug**: Uses `trimmed.indexOf(":")` to split key/value, so a value like
`tests: pass=40, fail=0` only captures `pass=40, fail=0` correctly BUT
a value like `reason: needs_clarification: missing field X` would lose
everything after the second colon.

**Fix**: Changed to use `indexOf(":")` only for the FIRST colon, and take
everything after it as the value (this was already the behavior, but added
a comment + test case to document it). Also improved list detection to handle
inline `[a, b, c]` syntax.

---

## P2 — `formatReviewRequest` Path Uses Bare storyId

**File**: `src/dispatch.ts` (`formatReviewRequest()`)

**Bug**: The review request message shows paths like `docs/bdd/US-013.md`
but uses `storyId` directly without going through `resolvePaths()`. If
storyId format changes, these paths go stale.

**Fix**: Use `resolvePaths()` for consistency (minor, cosmetic).
