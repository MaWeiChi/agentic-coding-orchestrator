/**
 * hook-log.test.js — Verify .ai/hook.log append behavior
 *
 * Tests that appendLog works correctly and that core functions
 * (dispatch, applyHandoff, rollback, startStory, sanitize)
 * produce log entries in .ai/hook.log.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, appendLog, sanitize, createInitialState, writeState } = require("../dist/state");
const { dispatch, applyHandoff, rollback, startStory, startCustom } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-hooklog-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

function readLog(tempDir) {
  const logPath = join(tempDir, ".ai", "hook.log");
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf-8");
}

function writeHandoff(tempDir, content) {
  const aiDir = join(tempDir, ".ai");
  mkdirSync(aiDir, { recursive: true });
  writeFileSync(join(aiDir, "HANDOFF.md"), content, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. appendLog() direct tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("appendLog: basic behavior", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("writes a timestamped line to .ai/hook.log", () => {
    // Create .ai/ directory
    mkdirSync(join(tempDir, ".ai"), { recursive: true });

    appendLog(tempDir, "INFO", "test", "hello world");

    const log = readLog(tempDir);
    assert.ok(log.includes("[INFO]"), "should contain level");
    assert.ok(log.includes("[test]"), "should contain context");
    assert.ok(log.includes("hello world"), "should contain message");
    // Check timestamp format (ISO 8601)
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(log), "should start with ISO timestamp");
  });

  it("appends multiple lines without overwriting", () => {
    mkdirSync(join(tempDir, ".ai"), { recursive: true });

    appendLog(tempDir, "INFO", "test", "line 1");
    appendLog(tempDir, "WARN", "test", "line 2");
    appendLog(tempDir, "ERROR", "test", "line 3");

    const log = readLog(tempDir);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 3, "should have 3 lines");
    assert.ok(lines[0].includes("line 1"));
    assert.ok(lines[1].includes("line 2"));
    assert.ok(lines[2].includes("line 3"));
  });

  it("silently skips when .ai/ does not exist", () => {
    // tempDir exists but .ai/ does not
    assert.doesNotThrow(
      () => appendLog(tempDir, "ERROR", "test", "should not crash"),
      "appendLog should not throw when .ai/ is missing"
    );
  });

  it("silently skips for nonexistent projectRoot", () => {
    assert.doesNotThrow(
      () => appendLog("/nonexistent/path", "ERROR", "test", "nope"),
      "appendLog should not throw for invalid path"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Core function logging
// ═══════════════════════════════════════════════════════════════════════════════

describe("hook.log: dispatch error logging", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("dispatch on nonexistent project logs STATE_NOT_FOUND", () => {
    // Create .ai/ but NOT STATE.json
    mkdirSync(join(tempDir, ".ai"), { recursive: true });

    const result = dispatch(tempDir);
    assert.equal(result.type, "error");

    const log = readLog(tempDir);
    assert.ok(log.includes("[ERROR]"), "should log ERROR level");
    assert.ok(log.includes("[dispatch]"), "should log dispatch context");
    assert.ok(log.includes("STATE_NOT_FOUND"), "should include error code");
  });

  it("dispatch timeout logs TIMEOUT entry", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      timeout_min: 10,
    });

    const result = dispatch(tempDir);
    assert.equal(result.type, "timeout");

    const log = readLog(tempDir);
    assert.ok(log.includes("[TIMEOUT]"), "should log TIMEOUT level");
    assert.ok(log.includes("impl"), "should include step name");
  });

  it("dispatch blocked logs WARN entry", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 5,
      max_attempts: 5,
      reason: null,
    });

    dispatch(tempDir);

    const log = readLog(tempDir);
    assert.ok(log.includes("[WARN]"), "should log WARN for blocked");
    assert.ok(log.includes("Max attempts"), "should mention max attempts");
  });
});

describe("hook.log: applyHandoff logging", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("stale HANDOFF logs WARN", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "running",
      attempt: 1,
      max_attempts: 2,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    writeHandoff(tempDir, `---
story: US-001
step: impl
status: pass
---
Done.`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale");

    const log = readLog(tempDir);
    assert.ok(log.includes("[WARN]"), "should log WARN for stale");
    assert.ok(log.includes("Stale HANDOFF"), "should mention stale");
    assert.ok(log.includes("[applyHandoff]"), "should have correct context");
  });

  it("successful applyHandoff logs INFO", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    writeHandoff(tempDir, `---
story: US-001
step: impl
attempt: 1
status: pass
tests_pass: 42
tests_fail: 0
tests_skip: 0
---
Done.`);

    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");

    const log = readLog(tempDir);
    assert.ok(log.includes("[INFO]"), "should log INFO for applied");
    assert.ok(log.includes("Applied HANDOFF"), "should mention applied");
    assert.ok(log.includes("42/0/0"), "should include test counts");
  });

  it("missing HANDOFF logs WARN", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "running",
      attempt: 1,
      max_attempts: 5,
      dispatched_at: new Date().toISOString(),
      timeout_min: 10,
    });

    // No HANDOFF.md written
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "missing");

    const log = readLog(tempDir);
    assert.ok(log.includes("[WARN]"), "should log WARN for missing");
    assert.ok(log.includes("No HANDOFF.md"), "should mention missing HANDOFF");
  });
});

describe("hook.log: rollback logging", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rollback error logs ERROR", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "impl",
      status: "failing",
      attempt: 3,
      max_attempts: 5,
    });

    const result = rollback(tempDir, "nonexistent");
    assert.equal(result.type, "error");

    const log = readLog(tempDir);
    assert.ok(log.includes("[ERROR]"), "should log ERROR");
    assert.ok(log.includes("[rollback]"), "should have rollback context");
    assert.ok(log.includes("INVALID_TARGET"), "should include error code");
  });

  it("rollback success logs INFO", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "verify",
      status: "failing",
      attempt: 2,
      max_attempts: 2,
    });

    const result = rollback(tempDir, "impl");
    assert.equal(result.type, "ok");

    const log = readLog(tempDir);
    assert.ok(log.includes("[INFO]"), "should log INFO for success");
    assert.ok(log.includes("Rolled back"), "should mention rollback");
  });
});

describe("hook.log: startStory logging", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("startStory success logs INFO", () => {
    const result = startStory(tempDir, "US-010");
    assert.equal(result.type, "ok");

    const log = readLog(tempDir);
    assert.ok(log.includes("[INFO]"), "should log INFO");
    assert.ok(log.includes("[startStory]"), "should have correct context");
    assert.ok(log.includes("US-010"), "should include story ID");
  });

  it("startStory already completed logs WARN", () => {
    setupState(tempDir, {
      story: "US-010",
      step: "done",
      status: "pass",
    });

    const result = startStory(tempDir, "US-010");
    assert.equal(result.type, "error");

    const log = readLog(tempDir);
    assert.ok(log.includes("[WARN]"), "should log WARN for already completed");
    assert.ok(log.includes("already completed"), "should mention already completed");
  });
});

describe("hook.log: sanitize warning logging", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("sanitize auto-correction logs WARN with projectRoot", () => {
    mkdirSync(join(tempDir, ".ai"), { recursive: true });

    const state = createInitialState("test-app");
    state.status = "done"; // invalid — should be corrected to "pass"

    const warnings = sanitize(state, tempDir);
    assert.ok(warnings.length > 0);

    const log = readLog(tempDir);
    assert.ok(log.includes("[WARN]"), "should log WARN for auto-correction");
    assert.ok(log.includes("[sanitize]"), "should have sanitize context");
    assert.ok(log.includes("done"), "should mention original value");
  });

  it("sanitize without projectRoot does NOT write log", () => {
    mkdirSync(join(tempDir, ".ai"), { recursive: true });

    const state = createInitialState("test-app");
    state.status = "done";

    // Call without projectRoot
    sanitize(state);

    const log = readLog(tempDir);
    assert.equal(log, "", "should not write log without projectRoot");
  });
});
