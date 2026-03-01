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
 * but production failed on the combined sequence.
 *
 * Stale HANDOFF detection uses a two-layer guard:
 *   1. Timestamp guard: HANDOFF.md mtime < state.dispatched_at → stale
 *   2. Step-name guard: HANDOFF.step != STATE.step → stale
 * rollback/reopen do NOT delete HANDOFF.md — the guards handle it.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } = require("fs");
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

/**
 * Write a HANDOFF with mtime set to a past date (before any dispatch).
 * This simulates a stale HANDOFF from a previous step.
 */
function writeStaleHandoff(tempDir, yamlFields) {
  writeHandoff(tempDir, yamlFields);
  const handoffPath = join(tempDir, ".ai", "HANDOFF.md");
  const pastDate = new Date("2020-01-01T00:00:00Z");
  utimesSync(handoffPath, pastDate, pastDate);
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

  it("stale HANDOFF from previous step is rejected, fresh HANDOFF applies", () => {
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

    // 2. User rolls back to scaffold — HANDOFF.md is NOT deleted
    //    (timestamp guard handles stale detection instead)
    const rbResult = rollback(tempDir, "scaffold");
    assert.equal(rbResult.type, "ok");
    assert.equal(rbResult.state.step, "scaffold");
    // HANDOFF still exists on disk — stale guard will handle it
    assert.ok(handoffExists(tempDir), "HANDOFF.md preserved (timestamp guard handles stale)");

    // 3. Dispatch scaffold step (sets dispatched_at, making old HANDOFF stale)
    const dispResult = dispatch(tempDir);
    assert.equal(dispResult.type, "dispatched");
    assert.equal(dispResult.step, "scaffold");

    // 4. applyHandoff with old HANDOFF → step-name guard catches it
    //    (HANDOFF.step="verify" != STATE.step="scaffold")
    const staleResult = applyHandoff(tempDir);
    assert.equal(staleResult.type, "stale", "step-name guard rejects verify HANDOFF for scaffold step");

    // 5. CC writes new HANDOFF for scaffold
    writeHandoff(tempDir, { story: "US-021", step: "scaffold", status: "pass" });

    // 6. SessionEnd hook fires → applyHandoff applies correctly
    const applyResult = applyHandoff(tempDir);
    assert.equal(applyResult.type, "applied");
    assert.equal(applyResult.state.step, "scaffold");
    assert.equal(applyResult.state.status, "pass");
  });

  it("step-name guard rejects stale HANDOFF after rollback (regression proof)", () => {
    // This documents the exact bug from US-021 production.
    // After rollback, old HANDOFF step "verify" != new STATE step "scaffold".
    // The step-name guard catches this regardless of HANDOFF file presence.
    setupState(tempDir, {
      story: "US-021",
      step: "verify",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-021", step: "verify", status: "pass" });

    // Rollback to scaffold — HANDOFF.md remains on disk
    rollback(tempDir, "scaffold");
    assert.ok(handoffExists(tempDir), "HANDOFF preserved (guards handle stale)");

    // Dispatch marks state as running with dispatched_at
    dispatch(tempDir);

    // Step-name guard: HANDOFF.step="verify" != STATE.step="scaffold"
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

  it("consecutive rollbacks: stale HANDOFFs rejected by guards", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "commit",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-001", step: "commit", status: "failing" });

    // Rollback to verify — HANDOFF stays but guards will catch it
    rollback(tempDir, "verify");

    // Dispatch verify — sets dispatched_at
    dispatch(tempDir);

    // Old HANDOFF has step="commit" but state is "verify" → step-name guard catches
    const staleResult1 = applyHandoff(tempDir);
    assert.equal(staleResult1.type, "stale", "commit HANDOFF rejected for verify step");

    // CC writes fresh HANDOFF for verify
    writeHandoff(tempDir, { story: "US-001", step: "verify", status: "pass" });
    applyHandoff(tempDir);

    // Now dispatch advances to commit, but something goes wrong → rollback to impl
    const state = readState(tempDir);
    state.step = "commit";
    state.status = "failing";
    writeState(tempDir, state);
    writeHandoff(tempDir, { story: "US-001", step: "commit", status: "failing" });

    rollback(tempDir, "impl");

    // Dispatch impl — sets new dispatched_at
    dispatch(tempDir);

    // Old HANDOFF has step="commit" but state is "impl" → step-name guard catches
    const staleResult2 = applyHandoff(tempDir);
    assert.equal(staleResult2.type, "stale", "commit HANDOFF rejected for impl step");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Reopen → Dispatch → applyHandoff lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: reopen → dispatch → applyHandoff", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("reopen: stale HANDOFF from done step rejected by guards", () => {
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
    // HANDOFF preserved — guards handle stale detection
    assert.ok(handoffExists(tempDir), "HANDOFF preserved (guards handle stale)");

    // Dispatch verify — sets dispatched_at
    dispatch(tempDir);

    // Old HANDOFF has step="update-memory" but state is "verify" → step-name guard catches
    const staleResult = applyHandoff(tempDir);
    assert.equal(staleResult.type, "stale", "update-memory HANDOFF rejected for verify step");

    // CC writes fresh HANDOFF for verify
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
// 4. Timestamp-based stale guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("lifecycle: timestamp stale guard", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("HANDOFF with old mtime rejected by timestamp guard", () => {
    setupState(tempDir, {
      story: "US-060",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    // Write HANDOFF with matching step but old timestamp
    writeStaleHandoff(tempDir, { story: "US-060", step: "impl", status: "pass" });

    // Dispatch sets dispatched_at to now
    dispatch(tempDir);

    // HANDOFF has correct step but mtime is far in the past → timestamp guard catches
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale", "timestamp guard rejects old HANDOFF");
    assert.ok(result.message.includes("older than"), "message explains timestamp mismatch");
  });

  it("HANDOFF written after dispatch passes timestamp guard", () => {
    setupState(tempDir, {
      story: "US-060",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 3,
    });

    // Dispatch first (sets dispatched_at)
    dispatch(tempDir);

    // Write HANDOFF after dispatch — mtime > dispatched_at
    writeHandoff(tempDir, { story: "US-060", step: "impl", status: "pass" });

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied", "fresh HANDOFF passes both guards");
    assert.equal(result.state.status, "pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Crash recovery
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

  it("CC crash after rollback: stale HANDOFF rejected, not double-fault", () => {
    setupState(tempDir, {
      story: "US-030",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });
    writeHandoff(tempDir, { story: "US-030", step: "verify", status: "failing" });

    // Rollback to impl — HANDOFF stays on disk
    rollback(tempDir, "impl");
    assert.ok(handoffExists(tempDir), "HANDOFF preserved (guards handle stale)");

    // Dispatch impl — sets dispatched_at
    dispatch(tempDir);

    // CC crashes without writing new HANDOFF.
    // Old HANDOFF has step="verify" but state is "impl" → step-name guard catches.
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale", "verify HANDOFF rejected for impl step");

    // State should still be running (not corrupted by stale HANDOFF)
    const state = readState(tempDir);
    assert.equal(state.status, "running");
    assert.equal(state.step, "impl");
  });
});
