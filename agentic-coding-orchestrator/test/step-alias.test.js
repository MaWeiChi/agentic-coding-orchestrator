/**
 * step-alias.test.js — STEP_ALIAS_MAP normalization in applyHandoff
 *
 * [FIX P0] CC executors write display-name variants as step names in
 * HANDOFF.md (e.g. "api-contract" instead of "contract"). Without
 * normalization, valid HANDOFFs are rejected as stale.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { applyHandoff } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-alias-"));
}

function writeHandoff(tempDir, yamlFields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(yamlFields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  lines.push("Test handoff body");
  const content = lines.join("\n");
  writeFileSync(join(tempDir, ".ai", "HANDOFF.md"), content, "utf-8");
}

function setupRunningState(tempDir, step) {
  const { state } = initState(tempDir, "test-app");
  state.story = "US-099";
  state.step = step;
  state.status = "running";
  state.dispatched_at = new Date().toISOString();
  writeState(tempDir, state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Alias normalization — should apply HANDOFF successfully
// ═══════════════════════════════════════════════════════════════════════════════

describe("step-alias: api-contract → contract", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("normalizes 'api-contract' to 'contract' and applies", () => {
    setupRunningState(tempDir, "contract");
    writeHandoff(tempDir, { step: "api-contract", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    assert.equal(result.state.step, "contract");
    assert.equal(result.state.status, "pass");
  });
});

describe("step-alias: test-scaffolding → scaffold", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("normalizes 'test-scaffolding' to 'scaffold' and applies", () => {
    setupRunningState(tempDir, "scaffold");
    writeHandoff(tempDir, { step: "test-scaffolding", status: "failing" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    assert.equal(result.state.step, "scaffold");
    assert.equal(result.state.status, "failing");
  });
});

describe("step-alias: implementation → impl", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("normalizes 'implementation' to 'impl' and applies", () => {
    setupRunningState(tempDir, "impl");
    writeHandoff(tempDir, { step: "implementation", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    assert.equal(result.state.step, "impl");
    assert.equal(result.state.status, "pass");
  });
});

describe("step-alias: quality-gate → verify", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("normalizes 'quality-gate' to 'verify' and applies", () => {
    setupRunningState(tempDir, "verify");
    writeHandoff(tempDir, { step: "quality-gate", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    assert.equal(result.state.step, "verify");
    assert.equal(result.state.status, "pass");
  });
});

describe("step-alias: update_memory → update-memory", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("normalizes 'update_memory' to 'update-memory' and applies", () => {
    setupRunningState(tempDir, "update-memory");
    writeHandoff(tempDir, { step: "update_memory", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
    assert.equal(result.state.step, "update-memory");
    assert.equal(result.state.status, "pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Canonical names still work (no regression)
// ═══════════════════════════════════════════════════════════════════════════════

describe("step-alias: canonical names unaffected", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("'contract' (canonical) still works", () => {
    setupRunningState(tempDir, "contract");
    writeHandoff(tempDir, { step: "contract", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
  });

  it("'scaffold' (canonical) still works", () => {
    setupRunningState(tempDir, "scaffold");
    writeHandoff(tempDir, { step: "scaffold", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
  });

  it("'bdd' (canonical) still works", () => {
    setupRunningState(tempDir, "bdd");
    writeHandoff(tempDir, { step: "bdd", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "applied");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. True stale HANDOFFs still rejected
// ═══════════════════════════════════════════════════════════════════════════════

describe("step-alias: true stale still rejected", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("rejects HANDOFF from genuinely different step", () => {
    setupRunningState(tempDir, "verify");
    writeHandoff(tempDir, { step: "bdd", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale");
  });

  it("rejects aliased step that doesn't match current", () => {
    setupRunningState(tempDir, "impl");
    // api-contract normalizes to "contract", but state is at "impl"
    writeHandoff(tempDir, { step: "api-contract", status: "pass" });
    const result = applyHandoff(tempDir);
    assert.equal(result.type, "stale");
  });
});
