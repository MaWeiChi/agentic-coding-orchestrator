/**
 * P2 Tests — Coverage gaps that don't immediately explode but accumulate risk
 *
 * Covers: auto.ts classify(), parseSimpleYaml edges, rules expectedSteps,
 *         startCustom(), generateChecklist(), detectFramework()
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

const { initState, readState, writeState, createInitialState } = require("../dist/state");
const {
  dispatch, parseHandoff, startCustom, detectFramework,
  generateChecklist,
} = require("../dist/dispatch");
const { classify } = require("../dist/auto");
const { getStepSequence, STEP_RULES, getRule } = require("../dist/rules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aco-p2-test-"));
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

// ─── P2-1: auto.ts classify() ──────────────────────────────────────────────

describe("P2: classify() intent detection", () => {
  it("classifies approve variants", () => {
    assert.equal(classify("approve").type, "approve");
    assert.equal(classify("lgtm").type, "approve");
    assert.equal(classify("核准").type, "approve");
    assert.equal(classify("approved").type, "approve");
  });

  it("classifies approve with note", () => {
    const result = classify("approve but rename the module");
    assert.equal(result.type, "approve");
    assert.equal(result.note, "but rename the module");
  });

  it("classifies reject variants", () => {
    assert.equal(classify("reject").type, "reject");
    assert.equal(classify("退回").type, "reject");
    assert.equal(classify("不行").type, "reject");
  });

  it("classifies reject with reason extraction", () => {
    const result = classify("reject clarification needed");
    assert.equal(result.type, "reject");
    assert.equal(result.reason, "needs_clarification");
  });

  it("classifies start story", () => {
    const result = classify("start story US-007");
    assert.equal(result.type, "start_story");
    assert.equal(result.storyId, "US-007");
  });

  it("classifies bare story ID", () => {
    const result = classify("US-007");
    assert.equal(result.type, "start_story");
    assert.equal(result.storyId, "US-007");
  });

  it("classifies query: status", () => {
    assert.equal(classify("狀態").type, "query");
    assert.equal(classify("status").type, "query");
    assert.equal(classify("目前進度").type, "query");
  });

  it("classifies continue", () => {
    assert.equal(classify("繼續").type, "continue");
    assert.equal(classify("continue").type, "continue");
    assert.equal(classify("next").type, "continue");
    assert.equal(classify("dispatch").type, "continue");
  });

  it("classifies fallback as custom", () => {
    const result = classify("refactor the auth module");
    assert.equal(result.type, "custom");
    assert.equal(result.instruction, "refactor the auth module");
  });

  it("classifies detect", () => {
    assert.equal(classify("framework").type, "detect");
    assert.equal(classify("有沒有用 framework").type, "detect");
  });

  it("classifies list", () => {
    assert.equal(classify("list projects").type, "list");
    assert.equal(classify("列出所有專案").type, "list");
  });
});

// ─── P2-2: parseSimpleYaml edge cases ────────────────────────────────────────

describe("P2: parseHandoff YAML edge cases", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("parses inline bracket list for files_changed", () => {
    const aiDir = join(tempDir, ".ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "HANDOFF.md"), `---
story: US-001
step: impl
status: pass
files_changed: [src/a.ts, src/b.ts]
---
Done.
`, "utf-8");

    const result = parseHandoff(tempDir);
    assert.deepEqual(result.files_changed, ["src/a.ts", "src/b.ts"],
      "inline bracket list should be parsed");
  });

  it("handles reason: null as empty/null", () => {
    const aiDir = join(tempDir, ".ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "HANDOFF.md"), `---
story: US-001
step: impl
status: pass
reason: null
---
`, "utf-8");

    const result = parseHandoff(tempDir);
    assert.equal(result.reason, null,
      "YAML 'null' should parse to null");
  });

  it("handles empty files_changed gracefully", () => {
    const aiDir = join(tempDir, ".ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "HANDOFF.md"), `---
story: US-001
step: impl
status: pass
---
`, "utf-8");

    const result = parseHandoff(tempDir);
    assert.deepEqual(result.files_changed, []);
  });

  it("handles value with colon (e.g., reason with details)", () => {
    const aiDir = join(tempDir, ".ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "HANDOFF.md"), `---
story: US-001
step: impl
status: failing
reason: needs_clarification
---
Error: something: went: wrong
`, "utf-8");

    const result = parseHandoff(tempDir);
    assert.equal(result.status, "failing");
    assert.equal(result.reason, "needs_clarification");
  });
});

// ─── P2-3: rules.test fix — expectedSteps vs getStepSequence ────────────────

describe("P2: rules consistency", () => {
  it("getStepSequence includes commit (9 steps, not 8)", () => {
    const seq = getStepSequence();
    assert.ok(seq.includes("commit"),
      "commit must be in step sequence");
    assert.equal(seq.length, 9,
      "pipeline has 9 steps: bdd, sdd-delta, contract, review, scaffold, impl, verify, commit, update-memory");
  });

  it("every step in getStepSequence has a rule in STEP_RULES", () => {
    const seq = getStepSequence();
    for (const step of seq) {
      assert.ok(STEP_RULES[step], `missing STEP_RULES entry for "${step}"`);
    }
  });

  it("STEP_RULES chain via next_on_pass ends at done", () => {
    let current = "bdd";
    const visited = new Set();
    while (current !== "done") {
      assert.ok(!visited.has(current), `cycle detected at step: ${current}`);
      visited.add(current);
      const rule = getRule(current);
      current = rule.next_on_pass;
    }
    assert.equal(visited.size, 9, "should visit all 9 steps before done");
  });
});

// ─── P2-4: startCustom() ────────────────────────────────────────────────────

describe("P2: startCustom()", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("sets up custom task state", () => {
    setupState(tempDir, {});

    const result = startCustom(tempDir, "Refactor auth module");
    assert.equal(result.type, "ok");
    const state = result.state;
    assert.equal(state.step, "custom");
    assert.equal(state.task_type, "custom");
    assert.equal(state.human_note, "Refactor auth module");
    assert.equal(state.status, "pending");
  });

  it("uses provided label", () => {
    setupState(tempDir, {});

    const result = startCustom(tempDir, "Fix bug", { label: "BUGFIX-001" });
    assert.equal(result.type, "ok");
    assert.equal(result.state.story, "BUGFIX-001");
  });
});

// ─── P2-5: generateChecklist() ──────────────────────────────────────────────

describe("P2: generateChecklist()", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("creates CHECKLIST.md with story ID", () => {
    setupState(tempDir, {});
    const path = generateChecklist(tempDir, "US-005");
    assert.ok(existsSync(path));
    const content = require("fs").readFileSync(path, "utf-8");
    assert.ok(content.includes("US-005"), "checklist should reference story ID");
    assert.ok(content.includes("## BDD"), "checklist should have BDD section");
    assert.ok(content.includes("## Implementation"), "checklist should have impl section");
  });
});

// ─── P2-6: detectFramework() ────────────────────────────────────────────────

describe("P2: detectFramework()", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("level 0 for empty project", () => {
    const result = detectFramework(tempDir);
    assert.equal(result.level, 0);
    assert.equal(result.has_state, false);
  });

  it("level 1 for partial adoption", () => {
    // Create just STATE.json
    mkdirSync(join(tempDir, ".ai"), { recursive: true });
    writeFileSync(join(tempDir, ".ai", "STATE.json"), "{}", "utf-8");
    // And PROJECT_MEMORY
    writeFileSync(join(tempDir, "PROJECT_MEMORY.md"), "# Memory", "utf-8");

    const result = detectFramework(tempDir);
    assert.equal(result.level, 1);
    assert.equal(result.has_state, true);
    assert.equal(result.has_memory, true);
  });

  it("level 2 for full adoption", () => {
    // Create all 5 core files
    mkdirSync(join(tempDir, ".ai"), { recursive: true });
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(join(tempDir, ".ai", "STATE.json"), "{}", "utf-8");
    writeFileSync(join(tempDir, "PROJECT_MEMORY.md"), "", "utf-8");
    writeFileSync(join(tempDir, "PROJECT_CONTEXT.md"), "", "utf-8");
    writeFileSync(join(tempDir, "docs", "constitution.md"), "", "utf-8");
    writeFileSync(join(tempDir, "docs", "sdd.md"), "", "utf-8");

    const result = detectFramework(tempDir);
    assert.equal(result.level, 2);
  });
});
