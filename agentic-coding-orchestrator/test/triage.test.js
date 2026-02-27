/**
 * triage.test.js — triage() test coverage
 *
 * Validates:
 *   1. Error cases (no PROJECT_MEMORY, no ISSUES, empty ISSUES)
 *   2. ISSUES parsing (unchecked items, checked items filtered out)
 *   3. Prompt content (issues listed, triage instructions present)
 *   4. Stateless — no STATE mutation
 *
 * [v0.8.0] FB-009: Review → Triage → Re-entry
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState } = require("../dist/state");
const { triage } = require("../dist/dispatch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-triage-"));
}

function setupWithMemory(tempDir, memoryContent) {
  const { state } = initState(tempDir, "test-app");
  state.story = "US-050";
  state.step = "done";
  writeState(tempDir, state);
  writeFileSync(join(tempDir, "PROJECT_MEMORY.md"), memoryContent);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Error Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("triage: error cases", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns NO_MEMORY when PROJECT_MEMORY.md missing", () => {
    const result = triage(tempDir);
    assert.equal(result.type, "error");
    assert.equal(result.code, "NO_MEMORY");
  });

  it("returns NO_ISSUES when ISSUES section empty", () => {
    setupWithMemory(tempDir, `# NOW
Working on something
## ISSUES
`);
    const result = triage(tempDir);
    assert.equal(result.type, "error");
    assert.equal(result.code, "NO_ISSUES");
  });

  it("returns NO_ISSUES when all items are checked", () => {
    setupWithMemory(tempDir, `## ISSUES
- [x] Old resolved bug
- [x] Another fixed item
`);
    const result = triage(tempDir);
    assert.equal(result.type, "error");
    assert.equal(result.code, "NO_ISSUES");
  });

  it("returns NO_ISSUES when no ISSUES section exists", () => {
    setupWithMemory(tempDir, `# NOW
Working on stuff
# NEXT
More stuff
`);
    const result = triage(tempDir);
    assert.equal(result.type, "error");
    assert.equal(result.code, "NO_ISSUES");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ISSUES Parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe("triage: issues parsing", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("parses unchecked items from ISSUES section", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Auth token expires too fast
- [ ] Missing error handling in /api/users
- [x] Fixed: login page crash
`);
    const result = triage(tempDir);
    assert.equal(result.type, "triage_prompt");
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues[0].includes("Auth token"));
    assert.ok(result.issues[1].includes("error handling"));
  });

  it("handles ### ISSUES header variant", () => {
    setupWithMemory(tempDir, `### ISSUES
- [ ] Bug in search
`);
    const result = triage(tempDir);
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].includes("Bug in search"));
  });

  it("stops collecting at next section header", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Real issue here
## NEXT
- [ ] This is not an issue, it's a NEXT item
`);
    const result = triage(tempDir);
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].includes("Real issue"));
  });

  it("handles linked format: issue text | linked: US-XXX", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Performance regression in search | linked: US-015
- [ ] Typo in error message
`);
    const result = triage(tempDir);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues[0].includes("linked: US-015"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Prompt Content
// ═══════════════════════════════════════════════════════════════════════════════

describe("triage: prompt content", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("prompt contains all issues numbered", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Issue alpha
- [ ] Issue beta
- [ ] Issue gamma
`);
    const result = triage(tempDir);
    assert.ok(result.prompt.includes("1. Issue alpha"));
    assert.ok(result.prompt.includes("2. Issue beta"));
    assert.ok(result.prompt.includes("3. Issue gamma"));
  });

  it("prompt contains triage classification instructions", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Some bug
`);
    const result = triage(tempDir);
    assert.ok(result.prompt.includes("REOPEN"));
    assert.ok(result.prompt.includes("NEW US"));
    assert.ok(result.prompt.includes("DISMISS"));
    assert.ok(result.prompt.includes("HUMAN-GATED"));
  });

  it("prompt contains output format section", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Some bug
`);
    const result = triage(tempDir);
    assert.ok(result.prompt.includes("OUTPUT FORMAT"));
    assert.ok(result.prompt.includes("SUMMARY"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Stateless — No State Mutation
// ═══════════════════════════════════════════════════════════════════════════════

describe("triage: stateless", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("does not mutate STATE.json", () => {
    setupWithMemory(tempDir, `## ISSUES
- [ ] Something wrong
`);
    const before = readState(tempDir);
    triage(tempDir);
    const after = readState(tempDir);
    assert.deepEqual(before, after);
  });
});
