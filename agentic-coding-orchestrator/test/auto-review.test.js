/**
 * auto-review.test.js — Feature 3 test coverage
 *
 * Tests for: Auto-trigger review after N stories complete
 *
 * After N stories reach "done", automatically suggest/trigger a review session.
 * The REVIEW_TRIGGER_THRESHOLD is currently set to 3.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, appendHistory } = require("../dist/state");
const { dispatch } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-review-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function writeToHistory(tempDir, content) {
  const historyPath = join(tempDir, ".ai", "history.md");
  let existing = "";
  try { existing = readFileSync(historyPath, "utf-8"); } catch {}
  writeFileSync(historyPath, existing + content, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Review Suggestion Triggering
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-review: review_suggested flag", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("does not suggest review when < 3 stories completed", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "update-memory",
      status: "pending",
    });

    // Add 2 reopen entries to history (represents 2 completed stories)
    writeToHistory(tempDir, "### Reopen — US-100 → impl\n");
    writeToHistory(tempDir, "### Reopen — US-101 → impl\n");

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    assert.equal(result.review_suggested, undefined);
  });

  it("suggests review when >= 3 stories completed", () => {
    setupState(tempDir, {
      story: "US-002",
      step: "update-memory",
      status: "pending",
    });

    // Add 3 reopen entries to history (represents 3 completed stories)
    writeToHistory(tempDir, "### Reopen — US-100 → impl\n");
    writeToHistory(tempDir, "### Reopen — US-101 → impl\n");
    writeToHistory(tempDir, "### Reopen — US-102 → impl\n");

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    assert.equal(result.review_suggested, true);
  });

  it("suggests review when > 3 stories completed", () => {
    setupState(tempDir, {
      story: "US-003",
      step: "update-memory",
      status: "pending",
    });

    // Add 5 reopen entries to history
    for (let i = 100; i < 105; i++) {
      writeToHistory(tempDir, `### Reopen — US-${i} → impl\n`);
    }

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    assert.equal(result.review_suggested, true);
  });

  it("does not add review_suggested if false (clean response)", () => {
    setupState(tempDir, {
      story: "US-004",
      step: "update-memory",
      status: "pending",
    });

    // No history entries

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    assert.ok(!("review_suggested" in result), "review_suggested should not be in result when false");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Threshold Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-review: threshold boundary conditions", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("does NOT suggest at exactly 2 completed stories", () => {
    setupState(tempDir, {
      story: "US-010",
      step: "update-memory",
      status: "pending",
    });

    writeToHistory(tempDir, "### Reopen — US-100 → bdd\n");
    writeToHistory(tempDir, "### Reopen — US-101 → scaffold\n");

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);
    assert.equal(result.review_suggested, undefined);
  });

  it("DOES suggest at exactly 3 completed stories (threshold)", () => {
    setupState(tempDir, {
      story: "US-011",
      step: "update-memory",
      status: "pending",
    });

    writeToHistory(tempDir, "### Reopen — US-100 → bdd\n");
    writeToHistory(tempDir, "### Reopen — US-101 → scaffold\n");
    writeToHistory(tempDir, "### Reopen — US-102 → verify\n");

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);
    assert.equal(result.review_suggested, true);
  });

  it("suggests at 4 completed stories", () => {
    setupState(tempDir, {
      story: "US-012",
      step: "update-memory",
      status: "pending",
    });

    for (let i = 100; i < 104; i++) {
      writeToHistory(tempDir, `### Reopen — US-${i} → impl\n`);
    }

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);
    assert.equal(result.review_suggested, true);
  });

  it("does not suggest when history.md does not exist", () => {
    setupState(tempDir, {
      story: "US-013",
      step: "update-memory",
      status: "pending",
    });

    // Do not write any history file

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);
    assert.equal(result.review_suggested, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Consistency with Done State
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-review: consistency with done state", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("review_suggested is only on 'done' type results", () => {
    setupState(tempDir, {
      story: "US-020",
      step: "impl",
      status: "pending",
    });

    const result = dispatch(tempDir);

    // This should be "dispatched", not "done"
    assert.equal(result.type, "dispatched");
    assert.ok(!("review_suggested" in result));
  });

  it("done result includes all expected fields plus review_suggested", () => {
    setupState(tempDir, {
      story: "US-021",
      step: "update-memory",
      status: "pending",
    });

    for (let i = 100; i < 103; i++) {
      writeToHistory(tempDir, `### Reopen — US-${i} → impl\n`);
    }

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    assert.equal(result.type, "done");
    assert.ok(result.story);
    assert.ok(result.summary);
    assert.equal(result.review_suggested, true);
  });

  it("clears reopened_from when reaching done", () => {
    setupState(tempDir, {
      story: "US-022",
      step: "update-memory",
      status: "pending",
      reopened_from: "impl",
    });

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    dispatch(tempDir);

    state = readState(tempDir);
    assert.equal(state.reopened_from, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Integration with Reopen Scenario
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-review: integration with reopen flow", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("counts reopens added to history by reopen() function", () => {
    // This test verifies that the appendHistory calls from reopen()
    // are properly counted by countCompletedStories

    setupState(tempDir, {
      story: "US-030",
      step: "done",
      status: "pending",
    });

    // Simulate the reopen() function's history entry (manually)
    const isoTimestamp = new Date().toISOString();
    const historyEntry = `### Reopen — US-030 → impl
- **Date**: ${isoTimestamp}
- **From**: done → impl
- **Note**: Test`;
    appendHistory(tempDir, historyEntry);

    // Now advance a story to completion
    setupState(tempDir, {
      story: "US-031",
      step: "update-memory",
      status: "pending",
    });

    let state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    // With 1 history entry, should NOT suggest review yet
    const result1 = dispatch(tempDir);
    assert.equal(result1.review_suggested, undefined);

    // Add 2 more entries
    for (let i = 0; i < 2; i++) {
      const entry = `### Reopen — US-${100 + i} → impl
- **Date**: ${new Date().toISOString()}
- **From**: done → impl
- **Note**: N/A`;
      appendHistory(tempDir, entry);
    }

    // Reset story to update-memory
    setupState(tempDir, {
      story: "US-032",
      step: "update-memory",
      status: "pending",
    });

    state = readState(tempDir);
    state.status = "pass";
    writeState(tempDir, state);

    // Now with 3 history entries, should suggest
    const result2 = dispatch(tempDir);
    assert.equal(result2.review_suggested, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. No Mutation During Non-Done Steps
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-review: stateless (no false positives)", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("does not suggest review when failing at verify (not done)", () => {
    setupState(tempDir, {
      story: "US-040",
      step: "verify",
      status: "pending",
    });

    for (let i = 100; i < 103; i++) {
      writeToHistory(tempDir, `### Reopen — US-${i} → impl\n`);
    }

    let state = readState(tempDir);
    state.status = "failing";
    writeState(tempDir, state);

    const result = dispatch(tempDir);

    // Should not be "done", so no review_suggested
    assert.notEqual(result.type, "done");
    assert.ok(!("review_suggested" in result));
  });

  it("does not suggest review when needs_human at review step", () => {
    setupState(tempDir, {
      story: "US-041",
      step: "review",
      status: "pending",
    });

    for (let i = 100; i < 103; i++) {
      writeToHistory(tempDir, `### Reopen — US-${i} → impl\n`);
    }

    const result = dispatch(tempDir);

    // Review step requires_human, so should return needs_human
    assert.equal(result.type, "needs_human");
    assert.ok(!("review_suggested" in result));
  });
});
