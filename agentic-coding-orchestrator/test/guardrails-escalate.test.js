/**
 * guardrails-escalate.test.js — Feature 1 test coverage
 *
 * Tests for: failed verify after reopen → auto-escalate rollback one level deeper
 *
 * When a story was reopened (e.g., to impl), and then verify fails,
 * instead of just retrying verify, the system escalates by rolling back
 * one step deeper than the reopen target.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { dispatch, reopen } = require("../dist/dispatch");
const { getRule, getStepSequence } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-escalate-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Escalation Trigger: verify fails after reopen
// ═══════════════════════════════════════════════════════════════════════════════

describe("guardrails: escalation on post-reopen verify failure", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("escalates verify fail → scaffold (reopened to impl)", () => {
    // Setup: completed story
    setupState(tempDir, {
      story: "US-001",
      step: "done",
      status: "pending",
      attempt: 1,
    });

    // Reopen to impl
    const reopenResult = reopen(tempDir, "impl");
    assert.equal(reopenResult.type, "ok");
    let state = readState(tempDir);
    assert.equal(state.step, "impl");
    assert.equal(state.reopened_from, "impl");

    // Advance to verify by marking impl as pass
    state.status = "pass";
    writeState(tempDir, state);

    // Dispatch to verify
    const dispatchToVerify = dispatch(tempDir);
    state = readState(tempDir);
    assert.equal(state.step, "verify");

    // Now verify fails (without a specific reason, so normal routing would retry)
    state.status = "failing";
    state.reason = null;
    writeState(tempDir, state);

    // Dispatch should escalate from verify → scaffold (one before impl)
    const verifyFailDispatch = dispatch(tempDir);

    // The dispatch result should indicate we're now at scaffold
    assert.equal(verifyFailDispatch.type, "dispatched");
    assert.equal(verifyFailDispatch.step, "scaffold");

    state = readState(tempDir);

    // Verify that we escalated to scaffold (not retrying verify)
    assert.equal(state.step, "scaffold", `Expected step to be "scaffold" after escalation, got "${state.step}"`);
    assert.equal(state.attempt, 1);
    assert.equal(state.status, "running");  // Dispatch marks it as running for execution
    // reopened_from should be cleared after escalation
    assert.equal(state.reopened_from, null);
  });

  it("escalates verify fail → contract (reopened to review)", () => {
    setupState(tempDir, {
      story: "US-002",
      step: "done",
      status: "pending",
    });

    const reopenResult = reopen(tempDir, "review");
    assert.equal(reopenResult.type, "ok");
    let state = readState(tempDir);
    assert.equal(state.reopened_from, "review");

    // Move through steps: review → scaffold → impl → verify
    state.status = "pass";  // review is human checkpoint, skip it
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "scaffold");
    state.status = "pass";
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "impl");
    state.status = "pass";
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "verify");

    // Now verify fails
    state.status = "failing";
    state.reason = null;
    writeState(tempDir, state);

    // Should escalate to contract (one before review in the sequence)
    const escalateResult = dispatch(tempDir);

    assert.equal(escalateResult.type, "dispatched");
    assert.equal(escalateResult.step, "contract");

    state = readState(tempDir);

    assert.equal(state.step, "contract");
    assert.equal(state.attempt, 1);
    assert.equal(state.status, "running");
    assert.equal(state.reopened_from, null);
  });

  it("does NOT escalate if reopened_from is not set", () => {
    setupState(tempDir, {
      story: "US-003",
      step: "verify",
      status: "pending",
      attempt: 1,
      max_attempts: 2,  // verify rule has max_attempts: 2
      reopened_from: null,  // Not a post-reopen scenario
      reason: null,
    });

    // Verify fails
    let state = readState(tempDir);
    state.status = "failing";
    writeState(tempDir, state);

    // Should NOT escalate (only escalates if reopened_from is set)
    // Normal fail target for verify is impl (default on_fail routing)
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "impl");

    state = readState(tempDir);

    assert.equal(state.step, "impl");
    assert.equal(state.attempt, 1);
    assert.equal(state.status, "running");
  });

  it("does NOT escalate if step is not verify", () => {
    setupState(tempDir, {
      story: "US-004",
      step: "impl",
      status: "pending",
      max_attempts: 5,  // impl rule has max_attempts: 5
      reopened_from: "impl",  // Post-reopen scenario
      reason: null,
    });

    // impl fails (not verify, so escalation shouldn't trigger)
    let state = readState(tempDir);
    state.status = "failing";
    writeState(tempDir, state);

    // Should NOT escalate (only verify escalates)
    // impl fails with no reason would normally retry
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "impl");

    state = readState(tempDir);
    assert.equal(state.step, "impl");
    assert.equal(state.attempt, 2);  // Retried
    assert.equal(state.status, "running");
    assert.equal(state.reopened_from, "impl");  // Still set since we didn't escalate
  });

  it("clears reopened_from when story reaches done (without failure)", () => {
    setupState(tempDir, {
      story: "US-005",
      step: "update-memory",
      status: "pending",
      reopened_from: "impl",
    });

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    // Dispatch should advance to done
    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    state = readState(tempDir);
    assert.equal(state.reopened_from, null);
  });

  it("does NOT escalate if reopened_from is the first step (bdd)", () => {
    // Edge case: if reopened to bdd, there's no earlier step to escalate to
    setupState(tempDir, {
      story: "US-006",
      step: "verify",
      status: "pending",
      max_attempts: 2,  // verify rule has max_attempts: 2
      reopened_from: "bdd",
    });

    let state = readState(tempDir);
    state.status = "failing";
    state.reason = null;
    writeState(tempDir, state);

    // Should fall back to normal routing (impl) since no earlier step
    const result = dispatch(tempDir);

    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "impl");  // Normal fail target for verify

    state = readState(tempDir);

    assert.equal(state.step, "impl");
    assert.equal(state.status, "running");
    assert.equal(state.reopened_from, "bdd");  // NOT cleared because we never escalated (no earlier step)
  });

  it("escalation respects max_attempts of target step", () => {
    setupState(tempDir, {
      story: "US-007",
      step: "done",
      status: "pending",
    });

    const reopenResult = reopen(tempDir, "impl");
    assert.equal(reopenResult.type, "ok");

    // Advance to verify
    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "verify");

    // Verify fails - escalate to scaffold
    state.status = "failing";
    state.reason = null;
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "scaffold");
    assert.equal(state.attempt, 1);
    assert.equal(state.status, "running");
    // scaffold rule should have its own max_attempts
    const scaffoldRule = getRule("scaffold");
    assert.equal(state.max_attempts, scaffoldRule.max_attempts);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Escalation with explicit failure reason
// ═══════════════════════════════════════════════════════════════════════════════

describe("guardrails: escalation respects explicit failure reasons", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("escalates verify failure with reason: null only", () => {
    setupState(tempDir, {
      story: "US-008",
      step: "done",
      status: "pending",
    });

    reopen(tempDir, "impl");
    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "verify");

    // Verify fails with reason = null (pure RED output)
    state.status = "failing";
    state.reason = null;
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    // Should escalate
    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "scaffold");

    state = readState(tempDir);
    assert.equal(state.step, "scaffold");
    assert.equal(state.status, "running");
  });

  it("does NOT escalate if verify failure has explicit reason", () => {
    setupState(tempDir, {
      story: "US-009",
      step: "done",
      status: "pending",
    });

    reopen(tempDir, "impl");
    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);
    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.step, "verify");

    // Verify fails with explicit reason (any reason other than null)
    state.status = "failing";
    state.reason = "constitution_violation";
    writeState(tempDir, state);

    dispatch(tempDir);
    state = readState(tempDir);

    // Should use reason-based routing (verify has no constitution_violation handler, falls back to default)
    // Since verify has no special routing for constitution_violation, it uses default: "impl"
    // NOT escalating to scaffold (only escalates with reason === null)
    assert.equal(state.step, "impl");
    assert.equal(state.reopened_from, "impl");  // Still set since we didn't escalate (only cleared on escalation)
  });
});
