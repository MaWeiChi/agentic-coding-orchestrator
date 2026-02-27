/**
 * reopen.test.js — Exhaustive reopen() test coverage
 *
 * Organizes tests by scenario category:
 *   1. Guard validation (reject when not done, invalid target)
 *   2. State reset correctness (what gets cleared, what's preserved)
 *   3. Rule adoption (max_attempts, timeout_min from target step)
 *   4. Human note passthrough
 *   5. Integration: reopen → dispatch (pipeline resumes correctly)
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { reopen, dispatch } = require("../dist/dispatch");
const { getRule, getStepSequence } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-reopen-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function setupDoneState(tempDir, story = "US-042") {
  return setupState(tempDir, {
    story,
    step: "done",
    status: "pending",
    attempt: 1,
    max_attempts: 1,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Guard Validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("reopen: guard validation", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rejects when step is not 'done'", () => {
    setupState(tempDir, { step: "impl", status: "pending", attempt: 1 });
    const result = reopen(tempDir, "bdd");
    assert.equal(result.type, "error");
    assert.equal(result.code, "NOT_DONE");
    assert.ok(result.message.includes("rollback"));
  });

  it("rejects when step is 'running' (not done)", () => {
    setupState(tempDir, { step: "verify", status: "running", attempt: 2 });
    const result = reopen(tempDir, "impl");
    assert.equal(result.type, "error");
    assert.equal(result.code, "NOT_DONE");
  });

  it("rejects invalid target step", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "nonexistent");
    assert.equal(result.type, "error");
    assert.equal(result.code, "INVALID_TARGET");
  });

  it("rejects reopen to 'done'", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "done");
    assert.equal(result.type, "error");
    assert.equal(result.code, "REOPEN_TO_DONE");
  });

  it("returns STATE_NOT_FOUND when no STATE.json", () => {
    const emptyDir = makeTempDir();
    const result = reopen(emptyDir, "impl");
    assert.equal(result.type, "error");
    assert.equal(result.code, "STATE_NOT_FOUND");
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. State Reset Correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("reopen: state reset", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("resets step, status, attempt correctly", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "impl");
    assert.equal(result.type, "ok");
    assert.equal(result.state.step, "impl");
    assert.equal(result.state.status, "pending");
    assert.equal(result.state.attempt, 1);
  });

  it("preserves story and project", () => {
    setupDoneState(tempDir, "US-099");
    const result = reopen(tempDir, "verify");
    assert.equal(result.state.story, "US-099");
    assert.equal(result.state.project, "test-app");
  });

  it("clears error-related fields", () => {
    setupState(tempDir, {
      step: "done",
      status: "pending",
      story: "US-001",
      last_error: "some old error",
      reason: "test_timeout",
      files_changed: ["foo.ts"],
      tests: { pass: 10, fail: 2, skip: 0 },
      failing_tests: ["test1"],
      lint_pass: false,
    });
    const result = reopen(tempDir, "scaffold");
    assert.equal(result.state.last_error, null);
    assert.equal(result.state.reason, null);
    assert.deepEqual(result.state.files_changed, []);
    assert.equal(result.state.tests, null);
    assert.deepEqual(result.state.failing_tests, []);
    assert.equal(result.state.lint_pass, null);
    assert.equal(result.state.dispatched_at, null);
    assert.equal(result.state.completed_at, null);
  });

  it("persists to disk", () => {
    setupDoneState(tempDir);
    reopen(tempDir, "bdd");
    const saved = readState(tempDir);
    assert.equal(saved.step, "bdd");
    assert.equal(saved.status, "pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Rule Adoption
// ═══════════════════════════════════════════════════════════════════════════════

describe("reopen: rule adoption", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("adopts max_attempts from target step rule", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "impl");
    const rule = getRule("impl");
    assert.equal(result.state.max_attempts, rule.max_attempts);
  });

  it("adopts timeout_min from target step rule", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "verify");
    const rule = getRule("verify");
    assert.equal(result.state.timeout_min, rule.timeout_min);
  });

  it("works for every valid step", () => {
    const sequence = getStepSequence().filter(s => s !== "done");
    for (const step of sequence) {
      const td = makeTempDir();
      setupDoneState(td);
      const result = reopen(td, step);
      assert.equal(result.type, "ok", `Failed for step "${step}"`);
      assert.equal(result.state.step, step);
      rmSync(td, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Human Note Passthrough
// ═══════════════════════════════════════════════════════════════════════════════

describe("reopen: human note", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("sets human_note when provided", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "impl", { humanNote: "Fix the auth bug" });
    assert.equal(result.state.human_note, "Fix the auth bug");
  });

  it("sets human_note to null when omitted", () => {
    setupDoneState(tempDir);
    const result = reopen(tempDir, "impl");
    assert.equal(result.state.human_note, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Integration: reopen → dispatch
// ═══════════════════════════════════════════════════════════════════════════════

describe("reopen: integration with dispatch", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("dispatch works after reopen", () => {
    setupDoneState(tempDir);
    const reopenResult = reopen(tempDir, "impl");
    assert.equal(reopenResult.type, "ok");

    const dispatchResult = dispatch(tempDir);
    assert.equal(dispatchResult.type, "dispatched");
    assert.equal(dispatchResult.step, "impl");
    assert.equal(dispatchResult.attempt, 1);
  });
});
