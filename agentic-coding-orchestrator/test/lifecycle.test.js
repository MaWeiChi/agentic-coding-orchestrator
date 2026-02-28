/**
 * lifecycle.test.js — End-to-end lifecycle tests
 *
 * Tests multi-step sequences that reflect real production usage:
 *   1. rollback → dispatch → CC writes HANDOFF → applyHandoff
 *   2. reopen → dispatch → CC writes HANDOFF → applyHandoff
 *   3. Multi-step pipeline with HANDOFF transitions
 *   4. Crash recovery (CC exits without writing HANDOFF)
 *
 * These tests exist because unit tests on individual functions passed,
 * but production failed on the combined sequence. The gap was:
 *   - rollback() didn't clear HANDOFF.md → stale guard blocked next step
 *   - applyHandoff() marked "failing" when CC hadn't written HANDOFF yet
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { dispatch, rollback, reopen, applyHandoff } = require("../dist/dispatch");
const { getStepSequence } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-lifecycle-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function writeHandoff(tempDir, yamlFields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(yamlFields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  lines.push("# HANDOFF body");
  const content = lines.join("\n");
  writeFileSync(join(tempDir, ".ai", "HANDOFF.md"), content, "utf-8");
}

function handoffExists(tempDir) {
  return existsSync(join(tempDir, ".ai", "HANDOFF.md"));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Rollback → Dispatch → applyHandoff lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: rollback → dispatch → applyHandoff", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rollback clears stale HANDOFF, fresh HANDOFF applies correctly", () => {
    // 1. Pipeline reached verify with a HANDOFF from verify step
    setupState(tempDir, {
      story: "US-021",
      step: "verify",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-021", step: "verify", status: "pass" });
    assert.ok(handoffExists(tempDir), "HANDOFF should exist before rollback");

    // 2. User rolls back to scaffold
    const rbResult = rollback(tempDir, "scaffold");
    assert.equal(rbResult.type, "ok");
    assert.equal(rbResult.state.step, "scaffold");
    assert.ok(!handoffExists(tempDir), "rollback must clear HANDOFF.md");

    // 3. Dispatch scaffold step
    const dispResult = dispatch(tempDir);
    assert.equal(dispResult.type, "dispatched");
    assert.equal(dispResult.step, "scaffold");

    // 4. Stop hook fires before CC writes HANDOFF → applyHandoff returns pending
    const pendingResult = applyHandoff(tempDir);
    assert.equal(pendingResult.type, "pending", "no HANDOFF + running → pending");

    // 5. CC writes new HANDOFF for scaffold
    writeHandoff(tempDir, { story: "US-021", step: "scaffold", status: "pass" });

    // 6. SessionEnd hook fires → applyHandoff applies correctly
    const applyResult = applyHandoff(tempDir);
    assert.equal(applyResult.type, "applied");
    assert.equal(applyResult.state.step, "scaffold");
    assert.equal(applyResult.state.status, "pass");
  });

  it("without rollback fix: stale HANDOFF causes stale rejection (regression proof)", () => {
    // This documents the exact bug from US-021 production.
    // After rollback, old HANDOFF step "verify" != new STATE step "scaffold".
    setupState(tempDir, {
      story: "US-021",
      step: "verify",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-021", step: "verify", status: "pass" });

    // Rollback now clears HANDOFF — verify it's gone
    rollback(tempDir, "scaffold");
    assert.ok(!handoffExists(tempDir), "HANDOFF cleared by rollback");

    // If someone manually restores the stale HANDOFF (simulating old behavior),
    // the stale guard still protects us
    writeHandoff(tempDir, { story: "US-021", step: "verify", status: "pass" });
    dispatch(tempDir); // marks running

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale", "stale guard rejects mismatched step");
    assert.ok(result.message.includes("verify"), "message mentions stale step");
    assert.ok(result.message.includes("scaffold"), "message mentions current step");
  });

  it("rollback → dispatch → CC writes alias step name → STEP_ALIAS_MAP normalizes", () => {
    setupState(tempDir, {
      story: "US-021",
      step: "impl",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });

    // Rollback to contract
    rollback(tempDir, "contract");
    dispatch(tempDir);

    // CC writes "api-contract" instead of "contract" (the alias bug)
    writeHandoff(tempDir, { story: "US-021", step: "api-contract", status: "pass" });

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied", "STEP_ALIAS_MAP normalizes api-contract → contract");
    assert.equal(result.state.status, "pass");
  });

  it("consecutive rollbacks: each clears HANDOFF", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "commit",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-001", step: "commit", status: "failing" });

    // Rollback to verify
    rollback(tempDir, "verify");
    assert.ok(!handoffExists(tempDir));

    // Simulate CC completing verify
    dispatch(tempDir);
    writeHandoff(tempDir, { story: "US-001", step: "verify", status: "pass" });
    applyHandoff(tempDir);

    // Now dispatch advances to commit, but something goes wrong → rollback to impl
    const state = readState(tempDir);
    state.step = "commit";
    state.status = "failing";
    writeState(tempDir, state);
    writeHandoff(tempDir, { story: "US-001", step: "commit", status: "failing" });

    rollback(tempDir, "impl");
    assert.ok(!handoffExists(tempDir), "second rollback also clears HANDOFF");

    // Dispatch impl
    dispatch(tempDir);
    const pendingResult = applyHandoff(tempDir);
    assert.equal(pendingResult.type, "pending", "no stale HANDOFF to confuse things");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Reopen → Dispatch → applyHandoff lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: reopen → dispatch → applyHandoff", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("reopen clears stale HANDOFF from done step", () => {
    setupState(tempDir, {
      story: "US-010",
      step: "done",
      status: "pass",
      attempt: 1,
      max_attempts: 1,
    });
    writeHandoff(tempDir, { story: "US-010", step: "update-memory", status: "pass" });

    const result = reopen(tempDir, "verify", { humanNote: "QA found regression" });
    assert.equal(result.type, "ok");
    assert.ok(!handoffExists(tempDir), "reopen must clear HANDOFF.md");

    // Dispatch verify
    dispatch(tempDir);

    // CC writes HANDOFF for verify
    writeHandoff(tempDir, { story: "US-010", step: "verify", status: "pass" });
    const applyResult = applyHandoff(tempDir);
    assert.equal(applyResult.type, "applied");
    assert.equal(applyResult.state.status, "pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Multi-step pipeline progression
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: multi-step pipeline", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("runs 3 consecutive steps: bdd → sdd-delta → contract", () => {
    setupState(tempDir, {
      story: "US-050",
      step: "bdd",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    const steps = ["bdd", "sdd-delta", "contract"];

    for (const step of steps) {
      // Dispatch current step
      const dispResult = dispatch(tempDir);
      assert.equal(dispResult.type, "dispatched");
      assert.equal(dispResult.step, step, `should dispatch ${step}`);

      // CC writes HANDOFF
      writeHandoff(tempDir, { story: "US-050", step, status: "pass" });

      // Apply HANDOFF → state advances
      const applyResult = applyHandoff(tempDir);
      assert.equal(applyResult.type, "applied");
      assert.equal(applyResult.state.status, "pass");
    }

    // After contract, next dispatch should advance (may need prerequisites)
    const nextDisp = dispatch(tempDir);
    // Could be "dispatched" or "needs_human" depending on prerequisite checks
    assert.ok(
      nextDisp.type === "dispatched" || nextDisp.type === "needs_human",
      `after contract, dispatch should advance or request prerequisites, got "${nextDisp.type}"`,
    );
  });

  it("HANDOFF from previous step doesn't pollute next step", () => {
    setupState(tempDir, {
      story: "US-050",
      step: "bdd",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    // Step 1: bdd → pass
    dispatch(tempDir);
    writeHandoff(tempDir, { story: "US-050", step: "bdd", status: "pass" });
    applyHandoff(tempDir);

    // Step 2: sdd-delta dispatched
    dispatch(tempDir);

    // Hook fires but HANDOFF.md still has bdd content (stale)
    // This simulates the race where old HANDOFF hasn't been overwritten yet
    const staleResult = applyHandoff(tempDir);
    assert.equal(staleResult.type, "stale", "bdd HANDOFF is stale for sdd-delta step");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Crash recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: crash recovery", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("CC crash mid-session: pending then synthetic HANDOFF marks failing", () => {
    setupState(tempDir, {
      story: "US-030",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    // Dispatch impl
    dispatch(tempDir);

    // Stop hook fires — no HANDOFF (CC crashed)
    const pendingResult = applyHandoff(tempDir);
    assert.equal(pendingResult.type, "pending", "running + no HANDOFF → pending");

    // dispatch-claude-code.sh step 5: synthesize failing HANDOFF
    writeHandoff(tempDir, {
      story: "US-030",
      step: "impl",
      status: "failing",
      reason: '"CC exited with code 1 without writing HANDOFF.md"',
    });

    // apply-handoff with synthetic HANDOFF
    const failResult = applyHandoff(tempDir);
    assert.equal(failResult.type, "applied");
    assert.equal(failResult.state.status, "failing");

    // Next dispatch should retry (attempt 2)
    const retryResult = dispatch(tempDir);
    assert.equal(retryResult.type, "dispatched");
    assert.equal(retryResult.step, "impl");
    assert.equal(retryResult.attempt, 2);
  });

  it("CC crash after rollback: no double-fault (pending, not failing)", () => {
    setupState(tempDir, {
      story: "US-030",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-030", step: "verify", status: "failing" });

    // Rollback to impl
    rollback(tempDir, "impl");
    assert.ok(!handoffExists(tempDir), "rollback clears HANDOFF");

    // Dispatch impl
    dispatch(tempDir);

    // CC crashes without writing HANDOFF
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "pending", "no HANDOFF + running → pending (not failing)");

    // State should still be running (not corrupted)
    const state = readState(tempDir);
    assert.equal(state.status, "running");
    assert.equal(state.step, "impl");
  });
});
