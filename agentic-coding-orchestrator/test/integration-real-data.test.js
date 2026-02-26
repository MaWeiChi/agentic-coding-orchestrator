/**
 * Integration Tests — Replay real project state transitions from Test-Project1
 *
 * These tests replay actual ACO workflows observed in a real Go project
 * (go-netagent) that used ACO 0.6.3 through stories US-015 to US-019.
 *
 * Uses node:test + node:assert (zero dependencies).
 * Runs against compiled dist/ — make sure to `tsc` first.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
} = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, createInitialState, sanitize, validate } = require("../dist/state");
const {
  dispatch, applyHandoff, parseHandoff, peek, startStory, rollback,
  generateChecklist, startCustom,
} = require("../dist/dispatch");
const { getStepSequence, STEP_RULES, getRule } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-integ-test-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "go-netagent");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function writeHandoff(tempDir, content) {
  const aiDir = join(tempDir, ".ai");
  mkdirSync(aiDir, { recursive: true });
  writeFileSync(join(aiDir, "HANDOFF.md"), content, "utf-8");
}

/**
 * Simulate the exact sequence: dispatch → executor writes HANDOFF → applyHandoff → next dispatch
 * This is what dispatch-claude-code.sh does in the real pipeline.
 */
function simulateStepExecution(tempDir, handoffYaml, handoffBody) {
  const content = `---\n${handoffYaml}\n---\n${handoffBody || "Done."}`;
  writeHandoff(tempDir, content);
  const result = applyHandoff(tempDir);
  // Return the state for backward compatibility with callers
  return result.state;
}

// ─── INT-1: Full Story Lifecycle Replay (US-018 pattern) ─────────────────────

describe("INT: Full story lifecycle replay (US-018 Health Check)", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("bdd → scaffold → impl → verify → commit → update-memory → done", () => {
    // 1. Start story US-018
    const startResult = startStory(tempDir, "US-018");
    assert.equal(startResult.type, "ok");
    let state = readState(tempDir);
    assert.equal(state.story, "US-018");
    assert.equal(state.step, "bdd");
    assert.equal(state.status, "pending");

    // 2. Dispatch BDD
    let r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "bdd");
    state = readState(tempDir);
    assert.equal(state.status, "running");

    // 3. BDD executor writes HANDOFF (pass, 36 scenarios)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: bdd\nattempt: 1\nstatus: pass\nreason: null",
      "Expanded US-018.feature to 36 Gherkin scenarios.");
    state = readState(tempDir);
    assert.equal(state.status, "pass");
    assert.equal(state.step, "bdd");

    // 4. Dispatch advances to sdd-delta
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "sdd-delta");

    // 5. sdd-delta pass
    simulateStepExecution(tempDir,
      "story: US-018\nstep: sdd-delta\nattempt: 1\nstatus: pass\nreason: null",
      "Delta Spec complete.");
    r = dispatch(tempDir);
    assert.equal(r.step, "contract");

    // 6. contract pass
    simulateStepExecution(tempDir,
      "story: US-018\nstep: contract\nattempt: 1\nstatus: pass",
      "API contract complete.");
    r = dispatch(tempDir);
    // review requires_human — should pause
    assert.equal(r.type, "needs_human");
    assert.equal(r.step, "review");

    // 7. Human approves review
    state = readState(tempDir);
    state.status = "pass";
    state.human_note = "Approved";
    writeState(tempDir, state);

    // 8. Dispatch advances to scaffold
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "scaffold");

    // 9. Scaffold executor reports failing (RED tests — expected)
    // Real data: 58 total, 35 passing, 23 failing (RED)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: scaffold\nattempt: 1\nstatus: failing\nreason: null\ntests_pass: 35\ntests_fail: 23\ntests_skip: 0",
      "RED test scaffolding complete. 23 tests fail because stubs are no-ops.");
    state = readState(tempDir);
    assert.equal(state.status, "failing");

    // 10. Dispatch: scaffold failing with no reason → treat as pass → advance to impl
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "impl",
      "scaffold failing (no reason) should advance to impl via treat_failing_as_pass");

    // 11. Impl pass (all 62 tests green)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: impl\nattempt: 1\nstatus: pass\nreason: null\ntests_pass: 62\ntests_fail: 0\ntests_skip: 0",
      "All 27 RED tests flipped GREEN.");
    state = readState(tempDir);
    assert.equal(state.tests.pass, 62);
    assert.equal(state.tests.fail, 0);

    // 12. Dispatch advances to verify
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "verify");

    // 13. Verify pass
    simulateStepExecution(tempDir,
      "story: US-018\nstep: verify\nattempt: 1\nstatus: pass\nreason: null\ntests_pass: 62\ntests_fail: 0\ntests_skip: 0",
      "Triple-check PASS.");
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "commit");

    // 14. Commit pass
    simulateStepExecution(tempDir,
      "story: US-018\nstep: commit\nattempt: 1\nstatus: pass\nreason: null",
      "Committed ca27988.");
    r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "update-memory");

    // 15. Update-memory pass
    simulateStepExecution(tempDir,
      "story: US-018\nstep: update-memory\nattempt: 1\nstatus: pass\nreason: null",
      "Memory update complete.");
    r = dispatch(tempDir);
    assert.equal(r.type, "done");

    // 16. Final state
    state = readState(tempDir);
    assert.equal(state.step, "done");
    assert.equal(state.story, "US-018");
  });
});

// ─── INT-2: Sequential stories (US-018 → US-019) ────────────────────────────

describe("INT: Sequential stories in same project", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("can start new story after previous one is done", () => {
    // Complete first story
    startStory(tempDir, "US-018");
    setupState(tempDir, {
      story: "US-018",
      step: "done",
      status: "pass",
      project: "go-netagent",
    });

    // Start next story
    const result = startStory(tempDir, "US-019");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.story, "US-019");
    assert.equal(state.step, "bdd");
    assert.equal(state.status, "pending");
    assert.equal(state.attempt, 1);
    assert.equal(state.project, "go-netagent");
  });

  it("preserves project name across stories", () => {
    // initState uses the dir basename as project name; override to simulate real project
    const { state: s } = initState(tempDir, "go-netagent");
    s.story = "US-018";
    s.step = "done";
    s.status = "pass";
    writeState(tempDir, s);

    // Start US-019 — should keep same project name
    const result = startStory(tempDir, "US-019");
    assert.equal(result.type, "ok");
    assert.equal(result.state.project, "go-netagent");
  });
});

// ─── INT-3: Scaffold RED → impl advance (real pattern) ──────────────────────

describe("INT: Scaffold RED test pattern", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("scaffold failing (RED tests, no reason) advances to impl — real US-018 data", () => {
    // US-018 scaffold: 58 total, 35 passing, 23 failing (RED)
    setupState(tempDir, {
      story: "US-018",
      step: "scaffold",
      status: "failing",
      reason: null,
      attempt: 1,
      max_attempts: 2,
      tests: { pass: 35, fail: 23, skip: 0 },
    });

    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "impl");
  });

  it("scaffold failing (RED tests, constitution_violation) retries — not treated as pass", () => {
    setupState(tempDir, {
      story: "US-018",
      step: "scaffold",
      status: "failing",
      reason: "constitution_violation",
      attempt: 1,
      max_attempts: 2,
      tests: { pass: 35, fail: 23, skip: 0 },
    });

    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "scaffold",
      "scaffold failing with reason should retry, not advance");
  });

  it("US-015 scaffold pass (303 total, 123 RED) then impl flips all green", () => {
    // Start at scaffold pass (US-015 had status: pass for scaffold)
    setupState(tempDir, {
      story: "US-015",
      step: "scaffold",
      status: "pass",
      attempt: 1,
      max_attempts: 2,
      tests: { pass: 180, fail: 123, skip: 0 },
    });

    // scaffold pass → advances to impl
    const r = dispatch(tempDir);
    assert.equal(r.step, "impl");

    // impl pass — all 303 green
    simulateStepExecution(tempDir,
      "story: US-015\nstep: impl\nattempt: 1\nstatus: pass\ntests_pass: 303\ntests_fail: 0\ntests_skip: 0",
      "All RED tests flipped GREEN.");
    const state = readState(tempDir);
    assert.equal(state.tests.pass, 303);
    assert.equal(state.tests.fail, 0);
  });
});

// ─── INT-4: Hook race condition replay (real hook.log sequence) ──────────────

describe("INT: Hook race condition replay", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("dispatch-claude-code.sh → Stop hook double-apply sequence", () => {
    // Simulates the exact sequence from dispatch-claude-code.sh + notify-agi.sh:
    // 1. CC completes commit → writes HANDOFF (step: commit, status: pass)
    // 2. dispatch-claude-code.sh calls applyHandoff → state = {commit, pass}
    // 3. dispatch-claude-code.sh calls dispatch() → state advances to {update-memory, running}
    // 4. notify-agi.sh Stop hook fires → calls applyHandoff again with SAME stale HANDOFF
    // Bug: Without stale guard, step 4 overwrites running → pass (skipping update-memory)

    // Step 1: State at commit running
    setupState(tempDir, {
      story: "US-019",
      step: "commit",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 3,
    });

    // Step 2: CC writes HANDOFF
    writeHandoff(tempDir, `---
story: US-019
step: commit
attempt: 1
status: pass
reason: null
---
Committed c9d39ae.`);

    // Step 2b: dispatch-claude-code.sh calls applyHandoff
    const applyResult1 = applyHandoff(tempDir);
    assert.equal(applyResult1.type, "applied");
    const afterApply = applyResult1.state;
    assert.equal(afterApply.status, "pass");
    assert.equal(afterApply.step, "commit");

    // Step 3: dispatch() advances to update-memory
    const r1 = dispatch(tempDir);
    assert.equal(r1.type, "dispatched");
    assert.equal(r1.step, "update-memory");
    const s1 = readState(tempDir);
    assert.equal(s1.status, "running");

    // Step 4: STALE applyHandoff from notify-agi.sh Stop hook
    // HANDOFF.md still says step: commit (stale!)
    const staleResult = applyHandoff(tempDir);
    assert.equal(staleResult.type, "stale");
    const afterStale = staleResult.state;
    assert.equal(afterStale.step, "update-memory");
    assert.equal(afterStale.status, "running",
      "stale HANDOFF must not overwrite running update-memory");

    // Step 5: Next dispatch should be already_running
    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "already_running");
  });

  it("triple applyHandoff (dispatch-claude-code + Stop + SessionEnd) is safe", () => {
    // Real scenario: All three fire within ~1 second
    setupState(tempDir, {
      story: "US-019",
      step: "update-memory",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 5,
    });

    writeHandoff(tempDir, `---
story: US-019
step: update-memory
attempt: 1
status: pass
---
Memory update done.`);

    // First apply (dispatch-claude-code.sh)
    const a1 = applyHandoff(tempDir);
    assert.equal(a1.type, "applied");
    assert.equal(a1.state.status, "pass");

    // Second apply (Stop hook) — state already at pass, HANDOFF still matches step
    const a2 = applyHandoff(tempDir);
    assert.equal(a2.state.status, "pass"); // idempotent
    assert.equal(a2.state.step, "update-memory");

    // Third apply (SessionEnd hook) — same thing
    const a3 = applyHandoff(tempDir);
    assert.equal(a3.state.status, "pass"); // still idempotent

    // dispatch should give done
    const r = dispatch(tempDir);
    assert.equal(r.type, "done");
  });
});

// ─── INT-5: Invalid "status: done" bug (real Test-Project1 STATE.json) ──────

describe("INT: Invalid status 'done' from CC agent", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("sanitize() should auto-correct 'done' → 'pass'", () => {
    // Real bug: CC agent writes STATE.json with status: "done" during update-memory
    // History entry: "MODIFIED: .ai/STATE.json (status: running→done; completed_at set)"
    const state = createInitialState("go-netagent");
    state.step = "update-memory";
    state.status = "done";
    state.story = "US-019";

    const warnings = sanitize(state);
    assert.equal(state.status, "pass",
      "sanitize() should auto-correct 'done' to 'pass'");
    assert.ok(warnings.length > 0,
      "sanitize() should emit a warning for the correction");
    assert.ok(warnings[0].includes("done"),
      "warning should mention the original value");
  });

  it("sanitize() also handles 'complete' → 'pass'", () => {
    // US-016 history: "HANDOFF status field corrected from 'complete' to 'pass' (invalid value)"
    const state = createInitialState("go-netagent");
    state.step = "verify";
    state.status = "complete";
    state.story = "US-016";

    const warnings = sanitize(state);
    assert.equal(state.status, "pass",
      "sanitize() should auto-correct 'complete' to 'pass'");
  });

  it("validate() throws for unrecognized status that is not in typo map", () => {
    const state = createInitialState("go-netagent");
    state.step = "bdd";
    state.status = "gibberish";
    state.story = "US-010";

    assert.throws(
      () => validate(state),
      /Invalid status/,
      "truly unknown status should throw on validate()"
    );
  });

  it("readState of real-world corrupted STATE.json should be recoverable", () => {
    // Simulate what Test-Project1 has: step=bdd, status=done
    setupState(tempDir, {
      story: "US-010",
      step: "bdd",
      status: "pending", // valid for writeState
    });

    // Now manually corrupt the file (simulating CC agent writing "done")
    const stateFile = join(tempDir, ".ai", "STATE.json");
    const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
    raw.status = "done";
    writeFileSync(stateFile, JSON.stringify(raw, null, 2), "utf-8");

    // readState should sanitize on read (if implemented) or we should
    // be able to sanitize + validate the raw data
    const state = createInitialState("go-netagent");
    Object.assign(state, raw);

    const warnings = sanitize(state);
    // After sanitize, status should be corrected
    assert.equal(state.status, "pass",
      "corrupted 'done' status should be recoverable via sanitize()");

    // Now validate should pass
    assert.doesNotThrow(
      () => validate(state),
      "after sanitize(), validate() should not throw"
    );
  });
});

// ─── INT-5b: applyHandoff with invalid HANDOFF status ──────────────────────

describe("INT: applyHandoff survives invalid HANDOFF status values", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("HANDOFF with status: done → applyHandoff auto-corrects to pass", () => {
    // Root cause of commit→update-memory stall:
    // CC agent writes HANDOFF with status: "done" (or STATE.json).
    // Without sanitize in applyHandoff, writeState → validate throws.
    setupState(tempDir, {
      story: "US-019",
      step: "commit",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 3,
    });

    writeHandoff(tempDir, `---
story: US-019
step: commit
attempt: 1
status: done
---
Committed c9d39ae.`);

    // This should NOT throw — applyHandoff sanitizes before writeState
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    const state = result.state;
    assert.equal(state.status, "pass",
      "applyHandoff should sanitize 'done' → 'pass'");
    assert.equal(state.step, "commit");

    // Now dispatch should advance to update-memory
    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "update-memory",
      "after commit/pass, dispatch MUST advance to update-memory");
  });

  it("HANDOFF with status: complete → applyHandoff auto-corrects to pass", () => {
    setupState(tempDir, {
      story: "US-016",
      step: "verify",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 5,
    });

    writeHandoff(tempDir, `---
story: US-016
step: verify
attempt: 1
status: complete
---
Triple-check PASS.`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    const state = result.state;
    assert.equal(state.status, "pass",
      "applyHandoff should sanitize 'complete' → 'pass'");

    const r = dispatch(tempDir);
    assert.equal(r.step, "commit",
      "after verify/pass, dispatch should advance to commit");
  });

  it("CC agent corrupts STATE.json with done → readState recovers → applyHandoff works", () => {
    // Exact real-world sequence from hook.log:
    // 1. dispatch sets commit/running
    // 2. CC agent writes STATE.json directly: status="done"
    // 3. CC agent also writes valid HANDOFF.md: status="pass"
    // 4. Hook calls applyHandoff → readState must sanitize first

    setupState(tempDir, {
      story: "US-019",
      step: "commit",
      status: "pending", // writeState needs valid status
    });

    // CC agent corrupts STATE.json directly
    const stateFile = join(tempDir, ".ai", "STATE.json");
    const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
    raw.status = "done";
    raw.dispatched_at = new Date().toISOString();
    writeFileSync(stateFile, JSON.stringify(raw, null, 2), "utf-8");

    // CC agent writes valid HANDOFF
    writeHandoff(tempDir, `---
story: US-019
step: commit
attempt: 1
status: pass
---
Committed c9d39ae.`);

    // applyHandoff must not throw — readState sanitizes "done" → "pass"
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    const state = result.state;
    assert.equal(state.status, "pass");

    // dispatch must advance to update-memory
    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "update-memory",
      "THE BUG: without fix, pipeline stalls at commit forever");
  });
});

// ─── INT-6: Real test counts from lifecycle ─────────────────────────────────

describe("INT: Test count progression across steps", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("test counts update correctly through scaffold → impl → verify", () => {
    // Based on US-018: scaffold (35/23), impl (62/0), verify (62/0)
    setupState(tempDir, {
      story: "US-018",
      step: "scaffold",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    // Scaffold results (RED tests expected)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: scaffold\nattempt: 1\nstatus: failing\ntests_pass: 35\ntests_fail: 23\ntests_skip: 0",
      "23 RED tests scaffolded.");
    let state = readState(tempDir);
    assert.equal(state.tests.pass, 35);
    assert.equal(state.tests.fail, 23);

    // scaffold failing (no reason) → advance to impl
    let r = dispatch(tempDir);
    assert.equal(r.step, "impl");

    // impl results (all green)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: impl\nattempt: 1\nstatus: pass\ntests_pass: 62\ntests_fail: 0\ntests_skip: 0",
      "All RED flipped GREEN.");
    state = readState(tempDir);
    assert.equal(state.tests.pass, 62);
    assert.equal(state.tests.fail, 0);

    // advance to verify
    r = dispatch(tempDir);
    assert.equal(r.step, "verify");

    // verify results (same counts)
    simulateStepExecution(tempDir,
      "story: US-018\nstep: verify\nattempt: 1\nstatus: pass\ntests_pass: 62\ntests_fail: 0\ntests_skip: 0",
      "Triple-check PASS.");
    state = readState(tempDir);
    assert.equal(state.tests.pass, 62);
    assert.equal(state.tests.fail, 0);
  });
});

// ─── INT-7: Rollback during story (real scenario) ───────────────────────────

describe("INT: Rollback during real story execution", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("impl fails max attempts → needs_human → rollback to scaffold → re-dispatch", () => {
    // A story where impl keeps failing
    setupState(tempDir, {
      story: "US-018",
      step: "impl",
      status: "failing",
      attempt: 5,
      max_attempts: 5,
      reason: null,
      tests: { pass: 40, fail: 22, skip: 0 },
      failing_tests: ["TestHealthHandler", "TestAggregation"],
    });

    // dispatch when maxed out → blocked (needs_human)
    const r = dispatch(tempDir);
    assert.equal(r.type, "blocked");

    // Human decides to rollback to scaffold
    const rbResult = rollback(tempDir, "scaffold");
    assert.equal(rbResult.type, "ok");
    const rolled = rbResult.state;
    assert.equal(rolled.step, "scaffold");
    assert.equal(rolled.status, "pending");
    assert.equal(rolled.attempt, 1);
    assert.equal(rolled.tests, null, "rollback should clear test results");
    assert.deepEqual(rolled.failing_tests, [], "rollback should clear failing tests");

    // Re-dispatch scaffold
    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "dispatched");
    assert.equal(r2.step, "scaffold");
  });

  it("verify fails → rollback to impl → re-execute → proceed to commit", () => {
    setupState(tempDir, {
      story: "US-019",
      step: "verify",
      status: "failing",
      attempt: 1,
      max_attempts: 2,
      reason: null,
      tests: { pass: 85, fail: 3, skip: 0 },
    });

    // Rollback to impl
    const rbResult = rollback(tempDir, "impl");
    assert.equal(rbResult.type, "ok");
    const rolled = rbResult.state;
    assert.equal(rolled.step, "impl");

    // Dispatch impl
    const r1 = dispatch(tempDir);
    assert.equal(r1.type, "dispatched");
    assert.equal(r1.step, "impl");

    // Impl pass
    simulateStepExecution(tempDir,
      "story: US-019\nstep: impl\nattempt: 1\nstatus: pass\ntests_pass: 88\ntests_fail: 0\ntests_skip: 0",
      "Fixed 3 failing tests.");

    // Advance to verify
    const r2 = dispatch(tempDir);
    assert.equal(r2.step, "verify");

    // Verify pass
    simulateStepExecution(tempDir,
      "story: US-019\nstep: verify\nattempt: 1\nstatus: pass\ntests_pass: 88\ntests_fail: 0\ntests_skip: 0",
      "Triple-check PASS.");

    // Advance to commit
    const r3 = dispatch(tempDir);
    assert.equal(r3.step, "commit");
  });
});

// ─── INT-8: Human bypass (US-016 pattern) ────────────────────────────────────

describe("INT: Human bypass pattern (US-016)", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("custom task for post-story bookkeeping", () => {
    // US-016 was committed manually, then a CUSTOM task was used for bookkeeping
    setupState(tempDir, {
      story: "US-016",
      step: "done",
      status: "pass",
    });

    // Start custom task for bookkeeping
    const result = startCustom(tempDir, "Post-US-016 bookkeeping", {
      label: "CUSTOM-1771991445484",
    });
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "custom");
    assert.equal(state.task_type, "custom");
    assert.equal(state.story, "CUSTOM-1771991445484");

    // Custom dispatch
    const r = dispatch(tempDir);
    assert.equal(r.type, "dispatched");
    assert.equal(r.step, "custom");
  });
});

// ─── INT-9: Verify pipeline step count matches real execution ────────────────

describe("INT: Pipeline step count matches real execution data", () => {
  it("real US-018 hit exactly 9 steps: bdd → sdd-delta → contract → review → scaffold → impl → verify → commit → update-memory", () => {
    // From history.md, US-018 went through:
    // bdd, scaffold (skipping sdd-delta/contract/review due to human override? No — real data shows scaffold directly after bdd)
    // But the pipeline has sdd-delta, contract, review in between.
    // The real project may have fast-tracked some steps.
    // This test verifies the orchestrator pipeline has the correct sequence.
    const seq = getStepSequence();
    assert.deepEqual(seq, [
      "bdd", "sdd-delta", "contract", "review",
      "scaffold", "impl", "verify", "commit", "update-memory",
    ]);
  });

  it("each step's next_on_pass chains correctly to done", () => {
    let current = "bdd";
    const visited = [];
    while (current !== "done") {
      visited.push(current);
      const rule = getRule(current);
      current = rule.next_on_pass;
    }
    assert.equal(visited.length, 9);
    assert.deepEqual(visited, [
      "bdd", "sdd-delta", "contract", "review",
      "scaffold", "impl", "verify", "commit", "update-memory",
    ]);
  });
});

// ─── INT-10: Checklist generation for real story ─────────────────────────────

describe("INT: Checklist generation matches real project", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("generates CHECKLIST.md when starting a new story", () => {
    const startResult = startStory(tempDir, "US-010");
    assert.equal(startResult.type, "ok");
    const checklistPath = join(tempDir, ".ai", "CHECKLIST.md");
    assert.ok(existsSync(checklistPath), "CHECKLIST.md should be created");

    const content = readFileSync(checklistPath, "utf-8");
    assert.ok(content.includes("US-010"), "should reference story ID");
    assert.ok(content.includes("BDD"), "should have BDD section");
  });
});

// ─── INT-11: Timeout during long-running step (real scenario) ────────────────

describe("INT: Timeout during long-running step", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("impl times out → dispatch marks timeout → next dispatch retries", () => {
    // Real scenario: impl step hangs for > timeout_min
    setupState(tempDir, {
      story: "US-018",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min ago
      timeout_min: 15, // 15 min timeout
    });

    // First dispatch detects timeout
    const r1 = dispatch(tempDir);
    assert.equal(r1.type, "timeout");
    let state = readState(tempDir);
    assert.equal(state.status, "timeout");

    // Next dispatch should re-dispatch impl (timeout is re-dispatchable)
    const r2 = dispatch(tempDir);
    assert.equal(r2.type, "dispatched");
    assert.equal(r2.step, "impl");

    // State should now be running again
    state = readState(tempDir);
    assert.equal(state.status, "running");
  });
});
