import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { initState, readState, writeState, createInitialState } from "../state";
import {
  dispatch,
  buildPrompt,
  parseHandoff,
  applyHandoff,
  approveReview,
  rejectReview,
  startStory,
} from "../dispatch";
import { getRule } from "../rules";

describe("dispatch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Helper: init project + start a story at a specific step/status */
  function setupState(overrides: Partial<ReturnType<typeof createInitialState>>) {
    const { state } = initState(tempDir, "test-app");
    Object.assign(state, overrides);
    writeState(tempDir, state);
    return state;
  }

  /** Helper: write a HANDOFF.md file */
  function writeHandoff(content: string) {
    const aiDir = join(tempDir, ".ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "HANDOFF.md"), content, "utf-8");
  }

  // ── dispatch() ────────────────────────────────────────────────────────────

  describe("dispatch()", () => {
    it("returns done when step is done", () => {
      setupState({ story: "US-001", step: "done", status: "pass" });
      const result = dispatch(tempDir);
      expect(result.type).toBe("done");
    });

    it("dispatches pending bootstrap step", () => {
      setupState({ step: "bootstrap", status: "pending" });
      const result = dispatch(tempDir);
      expect(result.type).toBe("dispatched");
      if (result.type === "dispatched") {
        expect(result.step).toBe("bootstrap");
        expect(result.attempt).toBe(1);
        expect(result.prompt).toContain("Bootstrap");
      }
    });

    it("advances from pass to next step", () => {
      setupState({
        story: "US-001",
        step: "bdd",
        status: "pass",
        attempt: 1,
        max_attempts: 3,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("dispatched");
      if (result.type === "dispatched") {
        expect(result.step).toBe("sdd-delta");
        expect(result.attempt).toBe(1);
      }
    });

    it("retries on failing with no specific reason", () => {
      setupState({
        story: "US-001",
        step: "impl",
        status: "failing",
        attempt: 2,
        max_attempts: 5,
        reason: null,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("dispatched");
      if (result.type === "dispatched") {
        expect(result.step).toBe("impl");
        expect(result.attempt).toBe(3);
      }
    });

    it("routes constitution_violation from impl to sdd-delta", () => {
      setupState({
        story: "US-001",
        step: "impl",
        status: "failing",
        attempt: 1,
        max_attempts: 5,
        reason: "constitution_violation",
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("dispatched");
      if (result.type === "dispatched") {
        expect(result.step).toBe("sdd-delta");
        expect(result.attempt).toBe(1);
      }
    });

    it("blocks when max_attempts exhausted", () => {
      setupState({
        story: "US-001",
        step: "impl",
        status: "failing",
        attempt: 5,
        max_attempts: 5,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("blocked");
    });

    it("pauses at review step", () => {
      setupState({
        story: "US-001",
        step: "review",
        status: "pending",
        attempt: 1,
        max_attempts: 1,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("needs_human");
    });

    it("returns already_running for running state", () => {
      setupState({
        story: "US-001",
        step: "impl",
        status: "running",
        dispatched_at: new Date().toISOString(),
        timeout_min: 10,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("already_running");
    });

    it("returns timeout for expired running state", () => {
      setupState({
        story: "US-001",
        step: "impl",
        status: "running",
        dispatched_at: new Date(Date.now() - 15 * 60_000).toISOString(),
        timeout_min: 10,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("timeout");
    });

    it("advances through review when pass", () => {
      setupState({
        story: "US-001",
        step: "review",
        status: "pass",
        attempt: 1,
        max_attempts: 1,
      });
      const result = dispatch(tempDir);
      expect(result.type).toBe("dispatched");
      if (result.type === "dispatched") {
        expect(result.step).toBe("scaffold");
      }
    });
  });

  // ── buildPrompt() ─────────────────────────────────────────────────────────

  describe("buildPrompt()", () => {
    it("includes step name and story", () => {
      const state = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 1 };
      const rule = getRule("impl");
      const prompt = buildPrompt(state, rule);
      expect(prompt).toContain("Implementation");
      expect(prompt).toContain("US-005");
    });

    it("includes attempt info when > 1", () => {
      const state = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 3, max_attempts: 5 };
      const rule = getRule("impl");
      const prompt = buildPrompt(state, rule);
      expect(prompt).toContain("Attempt 3 of 5");
    });

    it("omits attempt info when = 1", () => {
      const state = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 1 };
      const rule = getRule("impl");
      const prompt = buildPrompt(state, rule);
      expect(prompt).not.toContain("Attempt");
    });

    it("includes human_note when present", () => {
      const state = { ...createInitialState("app"), story: "US-005", step: "impl" as const, attempt: 1, human_note: "Fix the timezone bug" };
      const rule = getRule("impl");
      const prompt = buildPrompt(state, rule);
      expect(prompt).toContain("Fix the timezone bug");
      expect(prompt).toContain("Human Instruction");
    });

    it("includes HANDOFF output instructions", () => {
      const state = { ...createInitialState("app"), story: "US-005", step: "bdd" as const, attempt: 1 };
      const rule = getRule("bdd");
      const prompt = buildPrompt(state, rule);
      expect(prompt).toContain("YAML front matter");
      expect(prompt).toContain("needs_clarification");
      expect(prompt).toContain("constitution_violation");
    });

    it("includes failing tests on retry", () => {
      const state = {
        ...createInitialState("app"),
        story: "US-005",
        step: "impl" as const,
        attempt: 2,
        failing_tests: ["cart_test.go:TestApplyCoupon"],
      };
      const rule = getRule("impl");
      const prompt = buildPrompt(state, rule);
      expect(prompt).toContain("TestApplyCoupon");
    });
  });

  // ── parseHandoff() ────────────────────────────────────────────────────────

  describe("parseHandoff()", () => {
    it("returns null when no HANDOFF.md", () => {
      expect(parseHandoff(tempDir)).toBeNull();
    });

    it("parses YAML front matter", () => {
      writeHandoff(`---
story: US-005
step: impl
attempt: 2
status: failing
reason: null
files_changed:
  - internal/cart/service.go
  - internal/discount/engine.go
tests_pass: 42
tests_fail: 2
tests_skip: 1
---

# HANDOFF — US-005 impl attempt:2

## What was done
- Fixed timezone issue
`);
      const result = parseHandoff(tempDir);
      expect(result).not.toBeNull();
      expect(result!.story).toBe("US-005");
      expect(result!.step).toBe("impl");
      expect(result!.attempt).toBe(2);
      expect(result!.status).toBe("failing");
      expect(result!.reason).toBeNull();
      expect(result!.files_changed).toEqual([
        "internal/cart/service.go",
        "internal/discount/engine.go",
      ]);
      expect(result!.tests_pass).toBe(42);
      expect(result!.tests_fail).toBe(2);
      expect(result!.body).toContain("Fixed timezone issue");
    });

    it("parses pass status", () => {
      writeHandoff(`---
story: US-005
step: impl
attempt: 1
status: pass
reason: null
tests_pass: 44
tests_fail: 0
tests_skip: 0
---

All tests pass.
`);
      const result = parseHandoff(tempDir);
      expect(result!.status).toBe("pass");
      expect(result!.tests_fail).toBe(0);
    });

    it("falls back to grep for old format", () => {
      writeHandoff(`# HANDOFF

## Status
NEEDS CLARIFICATION: the coupon stacking rules are undefined.
`);
      const result = parseHandoff(tempDir);
      expect(result!.status).toBe("failing");
      expect(result!.reason).toBe("needs_clarification");
    });

    it("fallback treats no keyword as pass", () => {
      writeHandoff(`# HANDOFF

Everything done, all good.
`);
      const result = parseHandoff(tempDir);
      expect(result!.status).toBe("pass");
      expect(result!.reason).toBeNull();
    });
  });

  // ── applyHandoff() ────────────────────────────────────────────────────────

  describe("applyHandoff()", () => {
    it("applies HANDOFF results to STATE", () => {
      setupState({
        story: "US-005",
        step: "impl",
        status: "running",
        attempt: 2,
        max_attempts: 5,
      });
      writeHandoff(`---
story: US-005
step: impl
attempt: 2
status: pass
reason: null
files_changed:
  - internal/cart/service.go
tests_pass: 44
tests_fail: 0
tests_skip: 0
---

All tests pass.
`);
      const updated = applyHandoff(tempDir);
      expect(updated.status).toBe("pass");
      expect(updated.tests?.pass).toBe(44);
      expect(updated.files_changed).toEqual(["internal/cart/service.go"]);
      expect(updated.completed_at).toBeTruthy();
    });

    it("marks failing when no HANDOFF exists", () => {
      setupState({
        story: "US-005",
        step: "impl",
        status: "running",
        attempt: 1,
        max_attempts: 5,
      });
      // No HANDOFF.md written — executor crashed
      const updated = applyHandoff(tempDir);
      expect(updated.status).toBe("failing");
    });
  });

  // ── Review approval/rejection ──────────────────────────────────────────────

  describe("approveReview()", () => {
    it("sets review to pass", () => {
      setupState({ story: "US-001", step: "review", status: "needs_human" });
      approveReview(tempDir);
      const state = readState(tempDir);
      expect(state.status).toBe("pass");
    });

    it("attaches human note", () => {
      setupState({ story: "US-001", step: "review", status: "needs_human" });
      approveReview(tempDir, "Looks good, but rename the module");
      const state = readState(tempDir);
      expect(state.human_note).toBe("Looks good, but rename the module");
    });

    it("throws if not at review step", () => {
      setupState({ story: "US-001", step: "impl", status: "running" });
      expect(() => approveReview(tempDir)).toThrow("not \"review\"");
    });
  });

  describe("rejectReview()", () => {
    it("sets review to failing with reason", () => {
      setupState({ story: "US-001", step: "review", status: "needs_human" });
      rejectReview(tempDir, "needs_clarification", "What does 'fast' mean?");
      const state = readState(tempDir);
      expect(state.status).toBe("failing");
      expect(state.reason).toBe("needs_clarification");
      expect(state.human_note).toBe("What does 'fast' mean?");
    });
  });

  // ── startStory() ──────────────────────────────────────────────────────────

  describe("startStory()", () => {
    it("resets state for new story", () => {
      setupState({
        story: "US-001",
        step: "done",
        status: "pass",
        attempt: 3,
      });
      const state = startStory(tempDir, "US-002");
      expect(state.story).toBe("US-002");
      expect(state.step).toBe("bdd");
      expect(state.attempt).toBe(1);
      expect(state.status).toBe("pending");
      expect(state.reason).toBeNull();
      expect(state.tests).toBeNull();
    });
  });
});
