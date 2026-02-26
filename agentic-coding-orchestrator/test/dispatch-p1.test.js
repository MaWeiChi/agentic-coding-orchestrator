/**
 * P1 Tests — Conditions that cause incorrect behavior in specific scenarios
 *
 * Covers: peek(), rollback(), startStory() guards, timeout dispatch,
 *         checkPrerequisites(), treat_failing_as_pass
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, createInitialState } = require("../dist/state");
const {
  dispatch, peek, rollback, startStory, checkPrerequisites,
} = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-p1-test-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

// ─── P1-1: peek() dry-run guarantee ─────────────────────────────────────────

describe("P1: peek() does not mutate STATE", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("peek() returns same result type as dispatch() for pending step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    const peekResult = peek(tempDir);
    assert.equal(peekResult.type, "dispatched");
    assert.equal(peekResult.step, "impl");

    // State should still be pending, NOT running
    const state = readState(tempDir);
    assert.equal(state.status, "pending",
      "peek() should NOT mark state as running");
  });

  it("peek() does not write timeout status", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      dispatched_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      timeout_min: 10,
    });

    const peekResult = peek(tempDir);
    assert.equal(peekResult.type, "timeout");

    // State should still be running, NOT timeout
    const state = readState(tempDir);
    assert.equal(state.status, "running",
      "peek() should NOT persist timeout status");
  });
});

// ─── P1-2: rollback() ────────────────────────────────────────────────────────

describe("P1: rollback()", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rolls back to an earlier step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 3,
      max_attempts: 5,
      reason: null,
      last_error: "tests fail",
    });

    const result = rollback(tempDir, "bdd");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "bdd");
    assert.equal(state.status, "pending");
    assert.equal(state.attempt, 1);
    assert.equal(state.reason, null);
    assert.equal(state.last_error, null);
  });

  it("rejects rollback to current or later step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "verify");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ROLLBACK_FORWARD");
    assert.ok(result.message.includes("at or after"),
      "should reject rollback to a later step");
  });

  it("rejects rollback to same step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ROLLBACK_FORWARD");
    assert.ok(result.message.includes("at or after"),
      "should reject rollback to the same step");
  });

  it("rejects rollback to bootstrap without --force", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "bdd",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    const result = rollback(tempDir, "bootstrap");
    assert.equal(result.type, "error");
    assert.equal(result.code, "BOOTSTRAP_NEEDS_FORCE");
    assert.ok(/force/i.test(result.message),
      "should reject bootstrap rollback without force");
  });

  it("allows rollback to bootstrap with --force", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "bdd",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    const result = rollback(tempDir, "bootstrap", { force: true });
    assert.equal(result.type, "ok");
    assert.equal(result.state.step, "bootstrap");
  });

  it("rejects invalid target step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "nonexistent");
    assert.equal(result.type, "error");
    assert.equal(result.code, "INVALID_TARGET");
    assert.ok(result.message.includes("Invalid rollback target"));
  });

  it("allows rollback from done", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
      attempt: 1,
      max_attempts: 1,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "impl");
    assert.equal(state.status, "pending");
  });
});

// ─── P1-3: startStory() guards ──────────────────────────────────────────────

describe("P1: startStory() guards", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rejects restarting a completed story without --force", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
    });

    const result = startStory(tempDir, "US-001");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ALREADY_COMPLETED");
    assert.ok(result.message.includes("already completed"));
  });

  it("allows restarting a completed story with --force", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
    });

    const result = startStory(tempDir, "US-001", { force: true });
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "bdd");
    assert.equal(state.status, "pending");
  });

  it("rejects restarting a running story without --force", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    const result = startStory(tempDir, "US-001");
    assert.equal(result.type, "error");
    assert.equal(result.code, "ALREADY_RUNNING");
    assert.ok(result.message.includes("currently running"));
  });

  it("allows starting a different story even if current is done", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
    });

    const result = startStory(tempDir, "US-002");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.story, "US-002");
    assert.equal(state.step, "bdd");
  });
});

// ─── P1-4: timeout → next dispatch behavior ─────────────────────────────────

describe("P1: timeout handling", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("dispatch returns timeout for expired running state", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      timeout_min: 10,
    });

    const r = dispatch(tempDir);
    assert.equal(r.type, "timeout");

    // Check that state was updated to timeout
    const state = readState(tempDir);
    assert.equal(state.status, "timeout");
  });

  it("dispatch after timeout re-dispatches the step (timeout treated as pending)", () => {
    // After a timeout, the state is {step: impl, status: timeout}
    // Next dispatch should treat this as a re-dispatchable state
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "timeout",
      attempt: 1,
      max_attempts: 5,
    });

    // timeout is not running/pass/failing/needs_human, so it should
    // fall through to the dispatch executor section
    const r = dispatch(tempDir);
    // Document the actual behavior (this test captures what actually happens)
    assert.equal(r.type, "dispatched",
      "timeout status should be re-dispatchable");
    assert.equal(r.step, "impl");
  });
});

// ─── P1-5: checkPrerequisites() ──────────────────────────────────────────────

describe("P1: checkPrerequisites()", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns ok when done", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pass",
    });

    const result = checkPrerequisites(tempDir);
    assert.equal(result.ok, true);
  });

  it("reports missing prerequisite files", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    // impl reads: docs/bdd/US-{story}.md, docs/sdd.md, etc.
    // None of these exist → should report missing
    const result = checkPrerequisites(tempDir);
    assert.equal(result.ok, false);
    assert.ok(result.missing.length > 0, "should have missing files");
  });

  it("returns ok when all prerequisite files exist", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    // Create the prerequisite files
    const files = [
      "docs/bdd/US-001.md",
      "docs/sdd.md",
      "docs/api/openapi.yaml",
      ".ai/HANDOFF.md",
    ];
    for (const f of files) {
      const fullPath = join(tempDir, f);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, "placeholder", "utf-8");
    }

    const result = checkPrerequisites(tempDir);
    assert.equal(result.ok, true, "all prereqs exist → ok");
  });
});

// ─── P1-6: treat_failing_as_pass (scaffold step) ────────────────────────────

describe("P1: scaffold treat_failing_as_pass", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("scaffold failing (no reason) advances to impl", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "scaffold",
      status: "failing",
      reason: null,
      attempt: 1,
      max_attempts: 2,
    });

    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "impl",
      "scaffold failing with no reason → treat as pass → advance to impl");
  });

  it("scaffold failing WITH reason does NOT advance", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "scaffold",
      status: "failing",
      reason: "constitution_violation",
      attempt: 1,
      max_attempts: 2,
    });

    const r = dispatch(tempDir);
    // With a reason, it should NOT treat as pass
    // It should route through on_fail logic
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "scaffold",
      "scaffold failing with reason → retry, not advance");
  });
});
