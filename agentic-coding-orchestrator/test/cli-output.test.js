/**
 * cli-output.test.js — Verify CLI stdout contains <task-meta> JSON block
 *
 * Spawns `node dist/cli.js` as a subprocess and validates:
 *   - dispatch outputs prompt + <task-meta> JSON
 *   - peek outputs prompt + <task-meta> JSON (same format)
 *   - "already_running" scenario: dispatch gives no stdout,
 *     but peek still returns prompt + <task-meta>
 *
 * These tests catch the 0.7.1 bug where dispatch-claude-code.sh
 * couldn't start AGF because no <task-meta> was in the output.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, writeState } = require("../dist/state");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-cli-output-"));
}

function setupState(tempDir, overrides) {
  const { state } = initState(tempDir, "test-app");
  Object.assign(state, overrides);
  writeState(tempDir, state);
  return state;
}

/**
 * Run CLI command and capture stdout + stderr separately.
 * Returns { stdout, stderr, exitCode }.
 */
function runCli(command, projectRoot) {
  try {
    const stdout = execFileSync("node", [CLI_PATH, command, projectRoot], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status || 1,
    };
  }
}

/**
 * Extract <task-meta> JSON from CLI stdout.
 * Returns parsed object or null if not found.
 */
function extractTaskMeta(stdout) {
  const match = stdout.match(/<task-meta>\s*([\s\S]*?)\s*<\/task-meta>/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

/**
 * Extract prompt text (everything before <task-meta>).
 */
function extractPrompt(stdout) {
  const idx = stdout.indexOf("\n<task-meta>");
  return idx === -1 ? stdout.trim() : stdout.substring(0, idx).trim();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLI output: dispatch <task-meta>", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dispatch stdout contains <task-meta> JSON block", () => {
    setupState(tempDir, {
      story: "US-099",
      step: "impl",
      status: "pending",
    });

    const { stdout } = runCli("dispatch", tempDir);
    const meta = extractTaskMeta(stdout);

    assert.notEqual(meta, null, "stdout must contain <task-meta> block");
    assert.equal(meta.task_name, "US-099-impl");
    assert.equal(meta.story, "US-099");
    assert.equal(meta.step, "impl");
    assert.equal(meta.attempt, 1);
    assert.equal(typeof meta.fw_lv, "number");
  });

  it("dispatch stdout has prompt text before <task-meta>", () => {
    setupState(tempDir, {
      story: "US-099",
      step: "impl",
      status: "pending",
    });

    const { stdout } = runCli("dispatch", tempDir);
    const prompt = extractPrompt(stdout);

    assert.ok(prompt.length > 0, "prompt text must not be empty");
    // Prompt should not contain the task-meta tags
    assert.ok(!prompt.includes("<task-meta>"), "prompt should not include <task-meta> tag");
  });

  it("dispatch <task-meta> includes project field", () => {
    setupState(tempDir, {
      project: "my-project",
      story: "US-001",
      step: "bdd",
      status: "pending",
    });

    const { stdout } = runCli("dispatch", tempDir);
    const meta = extractTaskMeta(stdout);

    assert.equal(meta.project, "my-project");
  });

  it("dispatch already_running produces no <task-meta>", () => {
    setupState(tempDir, {
      story: "US-099",
      step: "impl",
      status: "running",
      dispatched_at: new Date().toISOString(),
    });

    const { stdout } = runCli("dispatch", tempDir);
    const meta = extractTaskMeta(stdout);

    assert.equal(meta, null, "already_running should not output <task-meta>");
  });
});

describe("CLI output: peek <task-meta>", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("peek stdout contains <task-meta> JSON block", () => {
    setupState(tempDir, {
      story: "US-050",
      step: "verify",
      status: "pending",
    });

    const { stdout } = runCli("peek", tempDir);
    const meta = extractTaskMeta(stdout);

    assert.notEqual(meta, null, "peek stdout must contain <task-meta> block");
    assert.equal(meta.task_name, "US-050-verify");
    assert.equal(meta.story, "US-050");
    assert.equal(meta.step, "verify");
  });

  it("peek does not mutate state to running", () => {
    setupState(tempDir, {
      story: "US-050",
      step: "verify",
      status: "pending",
    });

    runCli("peek", tempDir);

    const stateAfter = JSON.parse(
      readFileSync(join(tempDir, ".ai", "STATE.json"), "utf-8"),
    );
    assert.equal(stateAfter.status, "pending", "peek must not change status");
  });

  it("peek returns <task-meta> even when state is already running", () => {
    // This is the key scenario: OpenClaw dispatched, state is running,
    // dispatch-claude-code.sh falls back to peek — peek must still work.
    // peek skips the "already_running" guard and always generates the prompt.
    setupState(tempDir, {
      story: "US-050",
      step: "contract",
      status: "running",
      dispatched_at: new Date().toISOString(),
    });

    const { stdout } = runCli("peek", tempDir);
    const meta = extractTaskMeta(stdout);

    assert.notEqual(meta, null, "peek must return <task-meta> even when running");
    assert.equal(meta.step, "contract");
    assert.equal(meta.story, "US-050");
    assert.equal(meta.task_name, "US-050-contract");
  });

  it("peek does not mutate running state", () => {
    setupState(tempDir, {
      story: "US-050",
      step: "scaffold",
      status: "running",
      dispatched_at: new Date().toISOString(),
    });

    runCli("peek", tempDir);

    const stateAfter = JSON.parse(
      readFileSync(join(tempDir, ".ai", "STATE.json"), "utf-8"),
    );
    assert.equal(stateAfter.status, "running", "peek must not change running status");
  });
});

describe("CLI output: <task-meta> format consistency", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dispatch and peek produce identical <task-meta> for same state", () => {
    // Setup pending state
    setupState(tempDir, {
      story: "US-077",
      step: "scaffold",
      status: "pending",
    });

    // Run peek first (doesn't mutate)
    const peekResult = runCli("peek", tempDir);
    const peekMeta = extractTaskMeta(peekResult.stdout);

    // Run dispatch (will mutate to running)
    const dispatchResult = runCli("dispatch", tempDir);
    const dispatchMeta = extractTaskMeta(dispatchResult.stdout);

    assert.notEqual(peekMeta, null);
    assert.notEqual(dispatchMeta, null);
    assert.equal(peekMeta.task_name, dispatchMeta.task_name);
    assert.equal(peekMeta.step, dispatchMeta.step);
    assert.equal(peekMeta.story, dispatchMeta.story);
    assert.equal(peekMeta.fw_lv, dispatchMeta.fw_lv);
  });

  it("<task-meta> JSON is valid and parseable", () => {
    setupState(tempDir, {
      story: "US-001",
      step: "bdd",
      status: "pending",
    });

    const { stdout } = runCli("dispatch", tempDir);
    const match = stdout.match(/<task-meta>\s*([\s\S]*?)\s*<\/task-meta>/);

    assert.notEqual(match, null, "must have <task-meta> block");

    // Should not throw
    const parsed = JSON.parse(match[1]);
    assert.equal(typeof parsed.task_name, "string");
    assert.equal(typeof parsed.step, "string");
    assert.equal(typeof parsed.attempt, "number");
    assert.equal(typeof parsed.fw_lv, "number");
  });
});
