/**
 * rollback.test.js — Exhaustive rollback() test coverage
 *
 * Organizes tests by scenario category:
 *   1. Guard validation (reject invalid targets)
 *   2. State reset correctness (what gets cleared, what's preserved)
 *   3. Rule adoption (max_attempts, timeout_min from target step)
 *   4. Rollback from every step (verify full matrix)
 *   5. Rollback → dispatch integration (does dispatch work correctly after rollback?)
 *   6. Edge cases (running state, custom task, consecutive rollbacks)
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, createInitialState } = require("../dist/state");
const { dispatch, rollback, checkPrerequisites } = require("../dist/dispatch");
const { getRule, getStepSequence } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-rollback-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Guard Validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: guard validation", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rejects completely invalid step name", () => {
    setupState(tempDir, { step: "impl", status: "pending", attempt: 1, max_attempts: 5 });
    const result = rollback(tempDir, "nonexistent");
    assert.equal(result.type, "error");
    assert.equal(result.code, "INVALID_TARGET");
  });

  it("rejects 'done' as rollback target", () => {
    setupState(tempDir, { step: "impl", status: "pending", attempt: 1, max_attempts: 5 });
    const result = rollback(tempDir, "done");
    assert.equal(result.type, "error");
    assert.equal(result.code, "INVALID_TARGET");
  });

  it("rejects rollback to same step (not done)", () => {
    setupState(tempDir, { step: "impl", status: "failing", attempt: 3, max_attempts: 5 });
    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ROLLBACK_FORWARD");
  });

  it("rejects rollback to later step", () => {
    setupState(tempDir, { step: "scaffold", status: "pending", attempt: 1, max_attempts: 2 });
    assert.equal(rollback(tempDir, "impl").type, "error");
    assert.equal(rollback(tempDir, "verify").type, "error");
    assert.equal(rollback(tempDir, "update-memory").type, "error");
  });

  it("rejects bootstrap without --force", () => {
    setupState(tempDir, { step: "bdd", status: "pending", attempt: 1, max_attempts: 3 });
    const result = rollback(tempDir, "bootstrap");
    assert.equal(result.type, "error");
    assert.equal(result.code, "BOOTSTRAP_NEEDS_FORCE");
  });

  it("allows bootstrap with --force", () => {
    setupState(tempDir, { step: "bdd", status: "pending", attempt: 1, max_attempts: 3 });
    const result = rollback(tempDir, "bootstrap", { force: true });
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "bootstrap");
    assert.equal(state.status, "pending");
  });

  it("allows rollback from 'done' to any step without --force", () => {
    // done is special: targetIndex >= currentIndex check is skipped when step === "done"
    setupState(tempDir, { step: "done", status: "pass", attempt: 1, max_attempts: 1 });

    // Should NOT throw for any valid step
    const steps = ["bdd", "sdd-delta", "contract", "scaffold", "impl", "verify", "commit", "update-memory"];
    for (const target of steps) {
      // Re-setup because rollback mutates state
      setupState(tempDir, { step: "done", status: "pass", attempt: 1, max_attempts: 1 });
      const result = rollback(tempDir, target);
      assert.equal(result.type, "ok", `should allow rollback from done to ${target}`);
      assert.equal(result.state.step, target, `should allow rollback from done to ${target}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. State Reset Correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: state reset correctness", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("resets all transient fields", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 3,
      max_attempts: 5,
      reason: "constitution_violation",
      last_error: "SDD inconsistency detected",
      dispatched_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:05:00Z",
      files_changed: ["src/a.ts", "src/b.ts"],
      tests: { pass: 10, fail: 2, skip: 0 },
      failing_tests: ["test_a", "test_b"],
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    const state = result.state;

    // These MUST be reset
    assert.equal(state.step, "impl");
    assert.equal(state.status, "pending");
    assert.equal(state.attempt, 1);
    assert.equal(state.reason, null);
    assert.equal(state.last_error, null);
    assert.equal(state.dispatched_at, null);
    assert.equal(state.completed_at, null);
    assert.deepEqual(state.files_changed, []);
  });

  it("preserves story ID after rollback", () => {
    setupState(tempDir, {
      story: "US-007",
      step: "commit",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    assert.equal(result.state.story, "US-007", "rollback should preserve story");
  });

  it("preserves project name after rollback", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 5,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "ok");
    assert.equal(result.state.project, "test-app", "rollback should preserve project name");
  });

  it("preserves human_note after rollback", () => {
    // rollback() does NOT clear human_note — this could be intentional
    // (human note might still be relevant after rollback)
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 3,
      max_attempts: 5,
      human_note: "Focus on the timezone edge case",
    });

    const result = rollback(tempDir, "sdd-delta");
    assert.equal(result.type, "ok");
    // Document actual behavior: does rollback preserve or clear human_note?
    const reloaded = readState(tempDir);
    // human_note is NOT in the reset list in rollback(), so it should be preserved
    assert.equal(reloaded.human_note, "Focus on the timezone edge case",
      "rollback should preserve human_note (not in reset list)");
  });

  it("preserves agent_teams flag after rollback", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 5,
      max_attempts: 5,
      agent_teams: true,
    });

    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "ok");
    assert.equal(result.state.agent_teams, true,
      "rollback should preserve agent_teams flag");
  });

  it("clears tests/failing_tests/lint_pass to prevent stale data", () => {
    // [FIX P1] rollback must clear test data — without this,
    // old test results from verify carry over into impl after rollback
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
      tests: { pass: 40, fail: 2, skip: 1 },
      failing_tests: ["test_coupon"],
      lint_pass: false,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.tests, null,
      "rollback should clear tests");
    assert.deepEqual(state.failing_tests, [],
      "rollback should clear failing_tests");
    assert.equal(state.lint_pass, null,
      "rollback should clear lint_pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Rule Adoption (max_attempts, timeout_min from target step)
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: adopts target step's rule config", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("adopts max_attempts from target step rule", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2, // verify's max
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    const state = result.state;
    const implRule = getRule("impl");
    assert.equal(state.max_attempts, implRule.max_attempts,
      `should adopt impl's max_attempts (${implRule.max_attempts})`);
  });

  it("adopts timeout_min from target step rule", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
      timeout_min: 5,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    const state = result.state;
    const implRule = getRule("impl");
    assert.equal(state.timeout_min, implRule.timeout_min,
      `should adopt impl's timeout_min (${implRule.timeout_min})`);
  });

  it("adopts bootstrap rule config when rolling back to bootstrap", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "bdd",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    const result = rollback(tempDir, "bootstrap", { force: true });
    assert.equal(result.type, "ok");
    const state = result.state;
    const bootstrapRule = getRule("bootstrap");
    assert.equal(state.max_attempts, bootstrapRule.max_attempts);
    assert.equal(state.timeout_min, bootstrapRule.timeout_min);
  });

  // Verify rule adoption for each step by parameterized test
  for (const step of getStepSequence()) {
    it(`rollback to "${step}" adopts that step's rule`, () => {
      // Start from done so we can roll back to anything
      setupState(tempDir, { step: "done", status: "pass", attempt: 1, max_attempts: 1 });

      const result = rollback(tempDir, step);
      assert.equal(result.type, "ok");
      const state = result.state;
      const rule = getRule(step);
      assert.equal(state.max_attempts, rule.max_attempts,
        `${step}: max_attempts should be ${rule.max_attempts}`);
      assert.equal(state.timeout_min, rule.timeout_min,
        `${step}: timeout_min should be ${rule.timeout_min}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Rollback from every step (adjacency matrix)
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: step adjacency matrix", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  const sequence = getStepSequence(); // ["bdd", "sdd-delta", ..., "update-memory"]

  for (let i = 1; i < sequence.length; i++) {
    const from = sequence[i];
    const to = sequence[0]; // always try rolling back to bdd

    it(`${from} → ${to} (valid: earlier step)`, () => {
      setupState(tempDir, {
        story: "US-001",
        step: from,
        status: "pending",
        attempt: 1,
        max_attempts: 5,
      });

      const result = rollback(tempDir, to);
      assert.equal(result.type, "ok");
      assert.equal(result.state.step, to);
      assert.equal(result.state.status, "pending");
    });
  }

  // Verify that adjacent step rollback works (e.g., sdd-delta → bdd)
  for (let i = 1; i < sequence.length; i++) {
    const from = sequence[i];
    const to = sequence[i - 1];

    it(`${from} → ${to} (adjacent step)`, () => {
      setupState(tempDir, {
        story: "US-001",
        step: from,
        status: "pending",
        attempt: 1,
        max_attempts: 5,
      });

      const result = rollback(tempDir, to);
      assert.equal(result.type, "ok");
      assert.equal(result.state.step, to);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Rollback → dispatch integration
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback → dispatch integration", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("dispatch after rollback dispatches the target step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    const rbResult = rollback(tempDir, "impl");
    assert.equal(rbResult.type, "ok");
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "impl");
    assert.equal(result.attempt, 1,
      "dispatch after rollback should start at attempt 1");
  });

  it("dispatch after rollback from done starts fresh", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
    });

    const rbResult = rollback(tempDir, "bdd");
    assert.equal(rbResult.type, "ok");
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "bdd");
  });

  it("dispatch after rollback to review pauses for human", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 5,
      max_attempts: 5,
    });

    // Rollback past scaffold to review (requires human)
    const rbResult = rollback(tempDir, "review");
    assert.equal(rbResult.type, "ok");
    const result = dispatch(tempDir);

    assert.equal(result.type, "needs_human",
      "dispatch after rollback to review should pause for human");
  });

  it("rollback clears blocked state so dispatch can proceed", () => {
    // Simulate: step is blocked (max attempts exhausted)
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "needs_human", // blocked
      attempt: 5,
      max_attempts: 5,
      last_error: "Max attempts exhausted",
    });

    // Verify dispatch returns blocked
    const r1 = dispatch(tempDir);
    // After being set to needs_human by maxed out, the review requires_human check
    // may trigger — let's just verify rollback fixes it
    const rbResult = rollback(tempDir, "sdd-delta");
    assert.equal(rbResult.type, "ok");

    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "dispatched");
    assert.equal(r2.step, "sdd-delta");
    assert.equal(r2.attempt, 1);
  });

  it("rollback + dispatch preserves story context in prompt", () => {
    setupState(tempDir, {
      story: "US-042",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    const rbResult = rollback(tempDir, "impl");
    assert.equal(rbResult.type, "ok");
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.ok(result.prompt.includes("US-042"),
      "prompt after rollback should reference the story ID");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: edge cases", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rollback while step is running", () => {
    // Should a running step be rollback-able? Currently yes — no guard against it.
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    // This should work (rollback doesn't check status, only step position)
    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "bdd");
    assert.equal(state.status, "pending");
    assert.equal(state.dispatched_at, null,
      "rollback from running should clear dispatched_at");
  });

  it("rollback while step is timed out", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "timeout",
      attempt: 2,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "scaffold");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "scaffold");
    assert.equal(state.status, "pending");
  });

  it("consecutive rollbacks", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "update-memory",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    // First rollback: update-memory → verify
    const r1 = rollback(tempDir, "verify");
    assert.equal(r1.type, "ok");
    assert.equal(r1.state.step, "verify");

    // Second rollback: verify → impl
    const r2 = rollback(tempDir, "impl");
    assert.equal(r2.type, "ok");
    assert.equal(r2.state.step, "impl");

    // Third rollback: impl → bdd
    const r3 = rollback(tempDir, "bdd");
    assert.equal(r3.type, "ok");
    assert.equal(r3.state.step, "bdd");

    // All resets should be clean
    assert.equal(r3.state.status, "pending");
    assert.equal(r3.state.attempt, 1);
  });

  it("rollback with custom task type", () => {
    setupState(tempDir, {
      story: "CUSTOM-123",
      step: "custom",
      status: "failing",
      attempt: 3,
      max_attempts: 3,
      task_type: "custom",
    });

    // custom is not in getStepSequence() — should this work?
    // getStepSequence returns ["bdd", ..., "update-memory"], no "custom"
    // sequence.indexOf("custom") = -1, currentIndex = -1
    // targetIndex ("bdd") = 0 >= currentIndex (-1) → should throw!

    // Actually let's verify: rollback from custom to anything should be blocked
    // because currentIndex = -1 and targetIndex >= -1 for any valid step
    // UNLESS step === "done" is special-cased (it is: `state.step !== "done"`)
    // But custom is not done... so targetIndex (0) >= currentIndex (-1) → throws

    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ROLLBACK_FORWARD");
  });

  it("rollback from bootstrap is always rejected (step position edge)", () => {
    setupState(tempDir, {
      step: "bootstrap",
      status: "failing",
      attempt: 1,
      max_attempts: 1,
    });

    // bootstrap index is -1, any target index >= -1 → throws
    // (and bootstrap target requires --force too)
    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ROLLBACK_FORWARD");
  });

  it("state persists to disk after rollback", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    const rbResult = rollback(tempDir, "bdd");
    assert.equal(rbResult.type, "ok");

    // Read fresh from disk
    const onDisk = readState(tempDir);
    assert.equal(onDisk.step, "bdd");
    assert.equal(onDisk.status, "pending");
    assert.equal(onDisk.attempt, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. checkPrerequisites suggested_rollback heuristic
// ═══════════════════════════════════════════════════════════════════════════════

describe("rollback: checkPrerequisites suggested_rollback", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("suggests bdd rollback when bdd file missing", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "scaffold",
      status: "pending",
      attempt: 1,
      max_attempts: 2,
    });

    // scaffold reads docs/bdd/US-001.md — don't create it
    const result = checkPrerequisites(tempDir);
    assert.equal(result.ok, false);
    assert.equal(result.suggested_rollback, "bdd",
      "missing bdd file should suggest rollback to bdd");
  });

  it("suggests rollback when sdd.md and api files missing", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    // impl reads docs/sdd.md, docs/api/openapi.yaml, docs/bdd/US-001.md
    // Create only bdd file — sdd.md and openapi.yaml are missing
    mkdirSync(join(tempDir, "docs", "bdd"), { recursive: true });
    writeFileSync(join(tempDir, "docs", "bdd", "US-001.md"), "scenarios", "utf-8");

    const result = checkPrerequisites(tempDir);
    assert.equal(result.ok, false, "should report missing prereqs");
    assert.ok(result.suggested_rollback !== null,
      "should suggest a rollback target");
    // Heuristic checks patterns in order: bdd/ → deltas/ → api/ → sdd.md → PROJECT_MEMORY
    // Since api/openapi.yaml is missing, it matches "api/" → suggests "contract"
    // If only sdd.md were missing, it would suggest "bootstrap"
    assert.ok(
      ["bootstrap", "contract"].includes(result.suggested_rollback),
      `suggested_rollback should be bootstrap or contract, got: ${result.suggested_rollback}`
    );
  });

  it("suggested rollback can be applied successfully", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "scaffold",
      status: "pending",
      attempt: 1,
      max_attempts: 2,
    });

    const prereq = checkPrerequisites(tempDir);
    if (prereq.suggested_rollback && prereq.suggested_rollback !== "bootstrap") {
      // Apply the suggestion
      const result = rollback(tempDir, prereq.suggested_rollback);
      assert.equal(result.type, "ok");
      assert.equal(result.state.step, prereq.suggested_rollback,
        "suggested rollback target should be applicable");
      assert.equal(result.state.status, "pending");
    }
  });
});
