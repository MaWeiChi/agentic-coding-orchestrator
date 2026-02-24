/**
 * Minimal test runner — no dependencies required.
 * Run with: npx tsx run-tests.ts
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  createInitialState,
  readState,
  writeState,
  initState,
  validate,
  isTimedOut,
  isMaxedOut,
  markRunning,
  markCompleted,
} from "./src/state";

import {
  STEP_RULES,
  BOOTSTRAP_RULE,
  getRule,
  resolvePaths,
  getDispatchMode,
  getFailTarget,
  getStepSequence,
} from "./src/rules";

import {
  dispatch,
  buildPrompt,
  parseHandoff,
  applyHandoff,
  approveReview,
  rejectReview,
  startStory,
} from "./src/dispatch";

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentGroup = "";

function group(name: string) {
  currentGroup = name;
  console.log(`\n── ${name} ──`);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function expect(actual: any) {
  return {
    toBe(expected: any) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected: any) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toContain(sub: string) {
      if (typeof actual !== "string" || !actual.includes(sub))
        throw new Error(`Expected string containing "${sub}"`);
    },
    toThrow(msg?: string) {
      let threw = false;
      let error: any;
      try { actual(); } catch (e: any) { threw = true; error = e; }
      if (!threw) throw new Error("Expected to throw, but didn't");
      if (msg && !error.message.includes(msg))
        throw new Error(`Expected error containing "${msg}", got "${error.message}"`);
    },
    not: {
      toThrow() {
        try { actual(); } catch (e: any) {
          throw new Error(`Expected not to throw, but threw: ${e.message}`);
        }
      },
      toBeNull() {
        if (actual === null) throw new Error("Expected non-null");
      },
      toContain(sub: string) {
        if (typeof actual === "string" && actual.includes(sub))
          throw new Error(`Expected string NOT containing "${sub}"`);
      },
    },
  };
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setupState(dir: string, overrides: Partial<ReturnType<typeof createInitialState>>) {
  const { state } = initState(dir, "test-app");
  Object.assign(state, overrides);
  writeState(dir, state);
  return state;
}

function writeHandoff(dir: string, content: string) {
  const aiDir = join(dir, ".ai");
  mkdirSync(aiDir, { recursive: true });
  writeFileSync(join(aiDir, "HANDOFF.md"), content, "utf-8");
}

// ─── state.ts Tests ──────────────────────────────────────────────────────────

group("state — createInitialState");

test("creates state with correct defaults", () => {
  const s = createInitialState("my-app");
  expect(s.project).toBe("my-app");
  expect(s.step).toBe("bootstrap");
  expect(s.attempt).toBe(1);
  expect(s.status).toBe("pending");
  expect(s.reason).toBeNull();
});

group("state — validate");

test("accepts valid state", () => {
  expect(() => validate(createInitialState("app"))).not.toThrow();
});

test("rejects empty project", () => {
  expect(() => validate(createInitialState(""))).toThrow("project is required");
});

test("rejects invalid step", () => {
  const s = createInitialState("app"); (s as any).step = "invalid";
  expect(() => validate(s)).toThrow("Invalid step");
});

test("rejects invalid status", () => {
  const s = createInitialState("app"); (s as any).status = "banana";
  expect(() => validate(s)).toThrow("Invalid status");
});

test("accepts null reason", () => {
  expect(() => validate(createInitialState("app"))).not.toThrow();
});

test("accepts valid reason", () => {
  const s = createInitialState("app"); s.reason = "needs_clarification";
  expect(() => validate(s)).not.toThrow();
});

group("state — read/write round-trip");

test("writes and reads back identical state", () => {
  withTempDir((dir) => {
    const orig = createInitialState("app");
    orig.story = "US-001"; orig.step = "impl"; orig.attempt = 3;
    orig.status = "failing"; orig.reason = "constitution_violation";
    writeState(dir, orig);
    const loaded = readState(dir);
    expect(loaded).toEqual(orig);
  });
});

test("throws when reading non-existent STATE.json", () => {
  withTempDir((dir) => {
    expect(() => readState(dir)).toThrow("STATE.json not found");
  });
});

group("state — initState");

test("creates new state file", () => {
  withTempDir((dir) => {
    const { created, state } = initState(dir, "init-app");
    expect(created).toBe(true);
    expect(state.project).toBe("init-app");
  });
});

test("skips if already exists", () => {
  withTempDir((dir) => {
    initState(dir, "init-app");
    const { created, state } = initState(dir, "different");
    expect(created).toBe(false);
    expect(state.project).toBe("init-app");
  });
});

group("state — timeout / max");

test("isTimedOut returns false when not running", () => {
  expect(isTimedOut(createInitialState("app"))).toBe(false);
});

test("isTimedOut returns true when past timeout", () => {
  const s = createInitialState("app");
  s.status = "running";
  s.dispatched_at = new Date(Date.now() - 15 * 60_000).toISOString();
  s.timeout_min = 10;
  expect(isTimedOut(s)).toBe(true);
});

test("isMaxedOut returns true at max", () => {
  const s = createInitialState("app"); s.attempt = 5; s.max_attempts = 5;
  expect(isMaxedOut(s)).toBe(true);
});

test("markRunning sets status and timestamp", () => {
  const r = markRunning(createInitialState("app"));
  expect(r.status).toBe("running");
  expect(r.dispatched_at).toBeTruthy();
  expect(r.completed_at).toBeNull();
});

test("markCompleted sets status and reason", () => {
  const r = markRunning(createInitialState("app"));
  const d = markCompleted(r, "failing", "needs_clarification");
  expect(d.status).toBe("failing");
  expect(d.reason).toBe("needs_clarification");
});

// ─── rules.ts Tests ──────────────────────────────────────────────────────────

group("rules — completeness");

test("has rules for all 8 micro-waterfall steps", () => {
  const expected = ["bdd", "sdd-delta", "contract", "review", "scaffold", "impl", "verify", "update-memory"];
  for (const step of expected) {
    if (!(step in STEP_RULES)) throw new Error(`Missing rule for ${step}`);
  }
});

test("next_on_pass chain reaches done", () => {
  let current = "bdd";
  const visited = new Set<string>();
  while (current !== "done") {
    if (visited.has(current)) throw new Error(`Cycle at ${current}`);
    visited.add(current);
    current = STEP_RULES[current as keyof typeof STEP_RULES].next_on_pass;
  }
  expect(visited.size).toBe(8);
});

test("bootstrap → bdd", () => {
  expect(BOOTSTRAP_RULE.next_on_pass).toBe("bdd");
});

group("rules — lookup");

test("getRule returns bootstrap rule", () => {
  expect(getRule("bootstrap").display_name).toBe("Bootstrap");
});

test("getRule throws for done", () => {
  expect(() => getRule("done")).toThrow("No rule for");
});

test("resolvePaths replaces {story}", () => {
  expect(resolvePaths(["docs/bdd/US-{story}.md"], "005")).toEqual(["docs/bdd/US-005.md"]);
});

group("rules — dispatch mode");

test("S → single", () => { expect(getDispatchMode("S")).toBe("single"); });
test("L → team", () => { expect(getDispatchMode("L")).toBe("team"); });
test("M+0 → single", () => { expect(getDispatchMode("M", 0)).toBe("single"); });
test("M+2 → team", () => { expect(getDispatchMode("M", 2)).toBe("team"); });

group("rules — fail routing");

test("impl + constitution_violation → sdd-delta", () => {
  expect(getFailTarget("impl", "constitution_violation")).toBe("sdd-delta");
});

test("impl + needs_clarification → review", () => {
  expect(getFailTarget("impl", "needs_clarification")).toBe("review");
});

test("impl + null → impl (retry)", () => {
  expect(getFailTarget("impl", null)).toBe("impl");
});

test("review + needs_clarification → bdd", () => {
  expect(getFailTarget("review", "needs_clarification")).toBe("bdd");
});

// ─── dispatch.ts Tests ───────────────────────────────────────────────────────

group("dispatch — core");

test("returns done when step is done", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "done", status: "pass" });
    expect(dispatch(dir).type).toBe("done");
  });
});

test("dispatches pending bootstrap", () => {
  withTempDir((dir) => {
    setupState(dir, { step: "bootstrap", status: "pending" });
    const r = dispatch(dir);
    expect(r.type).toBe("dispatched");
    if (r.type === "dispatched") {
      expect(r.step).toBe("bootstrap");
      expect(r.prompt).toContain("Bootstrap");
    }
  });
});

test("advances from pass to next step", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "bdd", status: "pass", attempt: 1, max_attempts: 3 });
    const r = dispatch(dir);
    expect(r.type).toBe("dispatched");
    if (r.type === "dispatched") expect(r.step).toBe("sdd-delta");
  });
});

test("retries on failing", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "failing", attempt: 2, max_attempts: 5, reason: null });
    const r = dispatch(dir);
    expect(r.type).toBe("dispatched");
    if (r.type === "dispatched") { expect(r.step).toBe("impl"); expect(r.attempt).toBe(3); }
  });
});

test("routes constitution_violation to sdd-delta", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "failing", attempt: 1, max_attempts: 5, reason: "constitution_violation" });
    const r = dispatch(dir);
    expect(r.type).toBe("dispatched");
    if (r.type === "dispatched") expect(r.step).toBe("sdd-delta");
  });
});

test("blocks at max attempts", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "failing", attempt: 5, max_attempts: 5 });
    expect(dispatch(dir).type).toBe("blocked");
  });
});

test("pauses at review", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "review", status: "pending", attempt: 1, max_attempts: 1 });
    expect(dispatch(dir).type).toBe("needs_human");
  });
});

test("detects already running", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "running", dispatched_at: new Date().toISOString(), timeout_min: 10 });
    expect(dispatch(dir).type).toBe("already_running");
  });
});

test("detects timeout", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "running", dispatched_at: new Date(Date.now() - 15 * 60_000).toISOString(), timeout_min: 10 });
    expect(dispatch(dir).type).toBe("timeout");
  });
});

group("dispatch — buildPrompt");

test("includes step name and story", () => {
  const s = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 1 };
  const p = buildPrompt(s, getRule("impl"));
  expect(p).toContain("Implementation");
  expect(p).toContain("US-005");
});

test("includes attempt on retry", () => {
  const s = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 3, max_attempts: 5 };
  expect(buildPrompt(s, getRule("impl"))).toContain("Attempt 3 of 5");
});

test("includes human_note", () => {
  const s = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 1, human_note: "Fix timezone" };
  expect(buildPrompt(s, getRule("impl"))).toContain("Fix timezone");
});

test("includes HANDOFF instructions", () => {
  const s = { ...createInitialState("app"), story: "US-005", step: "bdd" as const, attempt: 1 };
  const p = buildPrompt(s, getRule("bdd"));
  expect(p).toContain("YAML front matter");
});

group("dispatch — parseHandoff");

test("returns null when no file", () => {
  withTempDir((dir) => { expect(parseHandoff(dir)).toBeNull(); });
});

test("parses YAML front matter", () => {
  withTempDir((dir) => {
    writeHandoff(dir, `---\nstory: US-005\nstep: impl\nattempt: 2\nstatus: failing\nreason: null\nfiles_changed:\n  - service.go\ntests_pass: 42\ntests_fail: 2\ntests_skip: 1\n---\n\n# Body\nFixed timezone.`);
    const r = parseHandoff(dir)!;
    expect(r.story).toBe("US-005");
    expect(r.status).toBe("failing");
    expect(r.tests_pass).toBe(42);
    expect(r.tests_fail).toBe(2);
    expect(r.files_changed).toEqual(["service.go"]);
    expect(r.body).toContain("Fixed timezone");
  });
});

test("fallback grep for old format", () => {
  withTempDir((dir) => {
    writeHandoff(dir, "# HANDOFF\nNEEDS CLARIFICATION: unclear spec.");
    const r = parseHandoff(dir)!;
    expect(r.status).toBe("failing");
    expect(r.reason).toBe("needs_clarification");
  });
});

group("dispatch — applyHandoff");

test("applies HANDOFF to STATE", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-005", step: "impl", status: "running", attempt: 2, max_attempts: 5 });
    writeHandoff(dir, `---\nstory: US-005\nstep: impl\nattempt: 2\nstatus: pass\nreason: null\ntests_pass: 44\ntests_fail: 0\ntests_skip: 0\n---\nAll pass.`);
    const u = applyHandoff(dir);
    expect(u.status).toBe("pass");
    expect(u.tests!.pass).toBe(44);
  });
});

test("marks failing when no HANDOFF", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-005", step: "impl", status: "running", attempt: 1, max_attempts: 5 });
    expect(applyHandoff(dir).status).toBe("failing");
  });
});

group("dispatch — review");

test("approveReview sets pass", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "review", status: "needs_human" });
    approveReview(dir, "Looks good");
    const s = readState(dir);
    expect(s.status).toBe("pass");
    expect(s.human_note).toBe("Looks good");
  });
});

test("rejectReview sets failing with reason", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "review", status: "needs_human" });
    rejectReview(dir, "needs_clarification", "What is fast?");
    const s = readState(dir);
    expect(s.status).toBe("failing");
    expect(s.reason).toBe("needs_clarification");
  });
});

test("approveReview throws if not at review", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "impl", status: "running" });
    expect(() => approveReview(dir)).toThrow('not "review"');
  });
});

group("dispatch — startStory");

test("resets state for new story", () => {
  withTempDir((dir) => {
    setupState(dir, { story: "US-001", step: "done", status: "pass", attempt: 3 });
    const s = startStory(dir, "US-002");
    expect(s.story).toBe("US-002");
    expect(s.step).toBe("bdd");
    expect(s.attempt).toBe(1);
    expect(s.status).toBe("pending");
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
