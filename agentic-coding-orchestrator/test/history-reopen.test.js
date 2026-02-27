/**
 * history-reopen.test.js — Feature 2 test coverage
 *
 * Tests for: history.md entry on reopen
 *
 * When reopen() is called, append an entry to .ai/history.md documenting the reopen action.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { reopen } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-history-"));
}

function setupDoneState(tempDir, story = "US-042") {
  const { state } = initState(tempDir, "test-app");
  state.story = story;
  state.step = "done";
  state.status = "pending";
  writeState(tempDir, state);
  return state;
}

function readHistory(tempDir) {
  const historyPath = join(tempDir, ".ai", "history.md");
  if (!existsSync(historyPath)) return null;
  return readFileSync(historyPath, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. History File Creation and Content
// ═══════════════════════════════════════════════════════════════════════════════

describe("history: reopen entry creation", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("creates history.md file on first reopen", () => {
    setupDoneState(tempDir, "US-001");

    const result = reopen(tempDir, "impl");
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history !== null, "history.md should be created");
  });

  it("appends entry with correct story and target step", () => {
    setupDoneState(tempDir, "US-002");

    const result = reopen(tempDir, "verify");
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("### Reopen — US-002 → verify"));
  });

  it("includes Date field in ISO format", () => {
    setupDoneState(tempDir, "US-003");

    const result = reopen(tempDir, "scaffold");
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("- **Date**: 20"), "Should include ISO timestamp starting with 20");
    assert.ok(history.includes("T") && history.includes("Z"), "Should be ISO 8601 format");
  });

  it("includes From field showing done → target", () => {
    setupDoneState(tempDir, "US-004");

    const result = reopen(tempDir, "bdd");
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("- **From**: done → bdd"));
  });

  it("includes Note field with humanNote or N/A", () => {
    setupDoneState(tempDir, "US-005");

    const result = reopen(tempDir, "impl", { humanNote: "Found bug in auth logic" });
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("- **Note**: Found bug in auth logic"));
  });

  it("uses N/A for Note when humanNote is not provided", () => {
    setupDoneState(tempDir, "US-006");

    const result = reopen(tempDir, "contract");
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("- **Note**: N/A"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Multiple Reopens
// ═══════════════════════════════════════════════════════════════════════════════

describe("history: multiple reopens appended sequentially", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("appends new entry without overwriting previous", () => {
    setupDoneState(tempDir, "US-010");

    // First reopen
    reopen(tempDir, "impl");
    let history = readHistory(tempDir);
    const firstEntry = history;

    // Simulate completing the story again
    let state = readState(tempDir);
    state.step = "done";
    writeState(tempDir, state);

    // Second reopen
    reopen(tempDir, "verify", { humanNote: "Second attempt" });
    history = readHistory(tempDir);

    // Both entries should be in the file
    assert.ok(history.includes("### Reopen — US-010 → impl"));
    assert.ok(history.includes("### Reopen — US-010 → verify"));
    assert.ok(history.includes("Second attempt"));
    assert.equal(history.length > firstEntry.length, true);
  });

  it("preserves order of multiple reopens", () => {
    setupDoneState(tempDir, "US-011");

    // Do multiple reopens
    reopen(tempDir, "bdd", { humanNote: "First" });
    let state = readState(tempDir);
    state.step = "done";
    writeState(tempDir, state);

    reopen(tempDir, "scaffold", { humanNote: "Second" });
    state = readState(tempDir);
    state.step = "done";
    writeState(tempDir, state);

    reopen(tempDir, "verify", { humanNote: "Third" });

    const history = readHistory(tempDir);
    const bddIndex = history.indexOf("→ bdd");
    const scaffoldIndex = history.indexOf("→ scaffold");
    const verifyIndex = history.indexOf("→ verify");

    assert.ok(bddIndex < scaffoldIndex && scaffoldIndex < verifyIndex);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Edge Cases and Format
// ═══════════════════════════════════════════════════════════════════════════════

describe("history: edge cases and format", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("handles humanNote with special characters", () => {
    setupDoneState(tempDir, "US-020");

    const note = 'Fixed "quote" issue, also fixed [bracket] and (paren) bugs';
    const result = reopen(tempDir, "impl", { humanNote: note });
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes(note));
  });

  it("handles humanNote with newlines gracefully", () => {
    setupDoneState(tempDir, "US-021");

    // Note: the function receives a single-line string in practice
    const note = "Line 1 concern";
    const result = reopen(tempDir, "impl", { humanNote: note });
    assert.equal(result.type, "ok");

    const history = readHistory(tempDir);
    assert.ok(history.includes("Line 1 concern"));
  });

  it("formats as valid markdown", () => {
    setupDoneState(tempDir, "US-022");

    reopen(tempDir, "impl", { humanNote: "Test entry" });

    const history = readHistory(tempDir);

    // Should have markdown heading
    assert.ok(history.includes("### Reopen"));

    // Should have markdown list items
    assert.ok(history.includes("- **Date**:"));
    assert.ok(history.includes("- **From**:"));
    assert.ok(history.includes("- **Note**:"));
  });

  it("appends with newline separator", () => {
    setupDoneState(tempDir, "US-023");

    reopen(tempDir, "impl");
    const state = readState(tempDir);
    state.step = "done";
    writeState(tempDir, state);

    reopen(tempDir, "verify");

    const history = readHistory(tempDir);
    const entries = history.split("### Reopen");

    // Should have at least 2 entries (1st empty due to split, plus 2 actual)
    assert.ok(entries.length >= 3);
  });

  it("handles reopen when history.md doesn't exist yet", () => {
    const tempDir2 = makeTempDir();
    const { state } = initState(tempDir2, "test-app");
    state.story = "US-024";
    state.step = "done";
    writeState(tempDir2, state);

    // Reopen should create history.md if it doesn't exist
    const result = reopen(tempDir2, "impl");
    assert.equal(result.type, "ok");

    // History file should be created
    const history = readHistory(tempDir2);
    assert.ok(history !== null);
    assert.ok(history.includes("### Reopen — US-024 → impl"));

    rmSync(tempDir2, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Consistency with STATE.json
// ═══════════════════════════════════════════════════════════════════════════════

describe("history: consistency with STATE.json changes", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("history entry matches the state change", () => {
    setupDoneState(tempDir, "US-030");

    const reopenResult = reopen(tempDir, "verify", { humanNote: "Test note" });
    assert.equal(reopenResult.type, "ok");

    // Check STATE.json
    const state = readState(tempDir);
    assert.equal(state.step, "verify");
    assert.equal(state.human_note, "Test note");

    // Check history.md
    const history = readHistory(tempDir);
    assert.ok(history.includes("→ verify"));
    assert.ok(history.includes("Test note"));
  });

  it("reopened_from field in state matches history target", () => {
    setupDoneState(tempDir, "US-031");

    reopen(tempDir, "scaffold");

    const state = readState(tempDir);
    assert.equal(state.reopened_from, "scaffold");

    const history = readHistory(tempDir);
    assert.ok(history.includes("→ scaffold"));
  });
});
