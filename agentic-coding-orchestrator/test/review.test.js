/**
 * review.test.js — review() test coverage
 *
 * Validates:
 *   1. Prompt generation at all framework levels (0, 1, 2)
 *   2. Prompt contains expected sections per level
 *   3. State is NOT mutated (stateless operation)
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { review } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-review-"));
}

function setupFullACF(tempDir) {
  const { state } = initState(tempDir, "test-app");
  state.story = "US-010";
  state.step = "impl";
  state.status = "pending";
  writeState(tempDir, state);

  // Create all framework files for level 2
  writeFileSync(join(tempDir, "PROJECT_MEMORY.md"), "# NOW\nWorking on US-010\n# ISSUES\n");
  writeFileSync(join(tempDir, "PROJECT_CONTEXT.md"), "# Context\nTest project");
  mkdirSync(join(tempDir, "docs"), { recursive: true });
  writeFileSync(join(tempDir, "docs", "constitution.md"), "# Constitution");
  writeFileSync(join(tempDir, "docs", "sdd.md"), "# SDD");
  return state;
}

function setupPartialACF(tempDir) {
  const { state } = initState(tempDir, "test-app");
  writeState(tempDir, state);
  writeFileSync(join(tempDir, "PROJECT_MEMORY.md"), "# NOW\nWorking");
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Framework Level Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("review: framework levels", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns fw_lv=2 for full ACF project", () => {
    setupFullACF(tempDir);
    const result = review(tempDir);
    assert.equal(result.type, "review_prompt");
    assert.equal(result.fw_lv, 2);
  });

  it("returns fw_lv=1 for partial ACF project", () => {
    setupPartialACF(tempDir);
    const result = review(tempDir);
    assert.equal(result.type, "review_prompt");
    assert.equal(result.fw_lv, 1);
  });

  it("returns fw_lv=0 for non-ACF project", () => {
    // No framework files at all
    const result = review(tempDir);
    assert.equal(result.type, "review_prompt");
    assert.equal(result.fw_lv, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Prompt Content Validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("review: prompt content", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("full ACF prompt contains all 5 checks", () => {
    setupFullACF(tempDir);
    const result = review(tempDir);
    assert.ok(result.prompt.includes("Code Review"));
    assert.ok(result.prompt.includes("Spec-Code Coherence"));
    assert.ok(result.prompt.includes("Regression"));
    assert.ok(result.prompt.includes("Security Scan"));
    assert.ok(result.prompt.includes("Memory Audit"));
  });

  it("partial ACF prompt contains 5 checks (lighter)", () => {
    setupPartialACF(tempDir);
    const result = review(tempDir);
    assert.ok(result.prompt.includes("Code Review"));
    assert.ok(result.prompt.includes("Security Scan"));
    assert.ok(result.prompt.includes("Memory Check"));
  });

  it("non-ACF prompt contains 3 checks", () => {
    const result = review(tempDir);
    assert.ok(result.prompt.includes("Code Review"));
    assert.ok(result.prompt.includes("Test Check"));
    assert.ok(result.prompt.includes("Security Scan"));
    // Should NOT contain Memory Audit (no framework)
    assert.ok(!result.prompt.includes("Memory Audit"));
  });

  it("prompt contains output format section", () => {
    setupFullACF(tempDir);
    const result = review(tempDir);
    assert.ok(result.prompt.includes("OUTPUT FORMAT"));
    assert.ok(result.prompt.includes("PASS"));
    assert.ok(result.prompt.includes("FAIL"));
    assert.ok(result.prompt.includes("REOPEN"));
    assert.ok(result.prompt.includes("NEW US"));
    assert.ok(result.prompt.includes("ALL CLEAR"));
  });

  it("full ACF prompt includes project and story info", () => {
    setupFullACF(tempDir);
    const result = review(tempDir);
    assert.ok(result.prompt.includes("test-app"));
    assert.ok(result.prompt.includes("US-010"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Stateless — No State Mutation
// ═══════════════════════════════════════════════════════════════════════════════

describe("review: stateless", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("does not mutate STATE.json", () => {
    setupFullACF(tempDir);
    const before = readState(tempDir);
    review(tempDir);
    const after = readState(tempDir);
    assert.deepEqual(before, after);
  });
});
