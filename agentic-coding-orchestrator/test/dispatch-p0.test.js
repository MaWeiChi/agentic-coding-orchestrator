/**
 * P0 Tests — Critical gaps that cause steps to be skipped or state corruption
 *
 * Uses node:test + node:assert (zero dependencies).
 * Runs against compiled dist/ — make sure to `tsc` first.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, createInitialState } = require("../dist/state");
const { dispatch, applyHandoff, parseHandoff, peek } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-p0-test-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function writeHandoff(tempDir, content) {
  const aiDir = join(tempDir, ".ai");
  mkdirSync(aiDir, { recursive: true });
  writeFileSync(join(aiDir, "HANDOFF.md"), content, "utf-8");
}

// ─── P0-1: Stale HANDOFF Race Condition ──────────────────────────────────────

describe("P0: stale HANDOFF guard", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("ignores HANDOFF when handoff.step !== state.step", () => {
    // State has advanced to update-memory (running)
    setupState(tempDir, {
      story: "US-001",
      step: "update-memory",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    // But HANDOFF.md is still from the commit step (stale)
    writeHandoff(tempDir, `---
story: US-001
step: commit
attempt: 1
status: pass
reason: null
tests_pass: 0
tests_fail: 0
tests_skip: 0
---

Commit done.
`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale", "stale HANDOFF should return stale result");
    const updated = result.state;
    assert.equal(updated.status, "running",
      "stale HANDOFF should NOT overwrite status from running to pass");
    assert.equal(updated.step, "update-memory",
      "step should remain update-memory");
  });

  it("stale HANDOFF does not set completed_at", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "update-memory",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
      completed_at: null,
    });

    writeHandoff(tempDir, `---
story: US-001
step: commit
status: pass
---
`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale");
    const updated = result.state;
    assert.equal(updated.completed_at, null,
      "stale HANDOFF should not set completed_at");
  });

  it("applies HANDOFF when handoff.step === state.step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 2,
      max_attempts: 5,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    writeHandoff(tempDir, `---
story: US-001
step: impl
attempt: 2
status: pass
reason: null
tests_pass: 44
tests_fail: 0
tests_skip: 0
---

All tests pass.
`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied", "matching step HANDOFF should be applied");
    const updated = result.state;
    assert.equal(updated.status, "pass",
      "matching step HANDOFF should set status to pass");
    assert.equal(updated.tests.pass, 44);
  });
});

// ─── P0-2: commit step transition ────────────────────────────────────────────

describe("P0: commit step in pipeline", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("verify pass → dispatches commit step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });

    const result = dispatch(tempDir);
    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "commit",
      "verify.next_on_pass should be commit");
  });

  it("commit pass → dispatches update-memory step", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "commit",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });

    const result = dispatch(tempDir);
    assert.equal(result.type, "dispatched");
    assert.equal(result.step, "update-memory",
      "commit.next_on_pass should be update-memory");
  });

  it("update-memory pass → done", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "update-memory",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
    });

    const result = dispatch(tempDir);
    assert.equal(result.type, "done",
      "update-memory.next_on_pass should be done");
  });
});

// ─── P0-3: Multi-step integration (dispatch → applyHandoff → dispatch) ──────

describe("P0: multi-step integration", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("full cycle: dispatch impl → applyHandoff pass → dispatch verify", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "pending",
      attempt: 1,
      max_attempts: 5,
    });

    // 1. dispatch impl
    const r1 = dispatch(tempDir);
    assert.equal(r1.type, "dispatched");
    assert.equal(r1.step, "impl");

    // Verify state is now running
    const s1 = readState(tempDir);
    assert.equal(s1.status, "running");

    // 2. Executor writes HANDOFF (pass)
    writeHandoff(tempDir, `---
story: US-001
step: impl
attempt: 1
status: pass
reason: null
tests_pass: 10
tests_fail: 0
tests_skip: 0
---
Done.
`);
    const h2 = applyHandoff(tempDir);
    assert.equal(h2.type, "applied");
    const s2 = h2.state;
    assert.equal(s2.status, "pass");

    // 3. Next dispatch should advance to verify
    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "dispatched");
    assert.equal(r2.step, "verify",
      "after impl pass, should advance to verify");
  });

  it("race: dispatch advances, stale HANDOFF arrives, next dispatch still works", () => {
    // Simulate the exact race condition from the bug report:
    // 1. CC completes commit → writes HANDOFF (step: commit, status: pass)
    // 2. dispatch-claude-code.sh calls applyHandoff → state = {commit, pass}
    // 3. dispatch() advances to {update-memory, pending} → marks running
    // 4. notify-agi.sh hook fires → calls applyHandoff again
    //    applyHandoff reads same HANDOFF (step: commit, status: pass)
    //    WITHOUT the fix: overwrites state to {update-memory, pass} → skip!
    //    WITH the fix: step mismatch → ignored

    // Step 1-2: commit complete
    setupState(tempDir, {
      story: "US-001",
      step: "commit",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 3,
    });

    writeHandoff(tempDir, `---
story: US-001
step: commit
attempt: 1
status: pass
reason: null
---
Committed abc123.
`);

    // First applyHandoff (from dispatch-claude-code.sh)
    const applyResult = applyHandoff(tempDir);
    assert.equal(applyResult.type, "applied");
    const afterApply = applyResult.state;
    assert.equal(afterApply.status, "pass");
    assert.equal(afterApply.step, "commit");

    // Step 3: dispatch advances to update-memory
    const r1 = dispatch(tempDir);
    assert.equal(r1.type, "dispatched");
    assert.equal(r1.step, "update-memory");

    // Verify state is now running at update-memory
    const s1 = readState(tempDir);
    assert.equal(s1.step, "update-memory");
    assert.equal(s1.status, "running");

    // Step 4: STALE applyHandoff (from notify-agi.sh hook)
    // HANDOFF.md still says step: commit
    const staleResult = applyHandoff(tempDir);
    assert.equal(staleResult.type, "stale", "should detect stale HANDOFF");
    const afterStaleApply = staleResult.state;

    // WITH the fix: state should still be running at update-memory
    assert.equal(afterStaleApply.step, "update-memory",
      "stale HANDOFF should not change step");
    assert.equal(afterStaleApply.status, "running",
      "stale HANDOFF should not overwrite running → pass");

    // Step 5: next dispatch should return already_running (not done!)
    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "already_running",
      "update-memory should still be running, not skipped to done");
  });
});
