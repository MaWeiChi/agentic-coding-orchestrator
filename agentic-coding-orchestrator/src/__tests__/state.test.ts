import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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
} from "../state";

describe("state", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createInitialState", () => {
    it("creates state with correct defaults", () => {
      const state = createInitialState("my-app");
      expect(state.project).toBe("my-app");
      expect(state.step).toBe("bootstrap");
      expect(state.attempt).toBe(1);
      expect(state.status).toBe("pending");
      expect(state.reason).toBeNull();
      expect(state.story).toBeNull();
    });
  });

  describe("validate", () => {
    it("accepts valid state", () => {
      const state = createInitialState("app");
      expect(() => validate(state)).not.toThrow();
    });

    it("rejects empty project", () => {
      const state = createInitialState("");
      expect(() => validate(state)).toThrow("project is required");
    });

    it("rejects invalid step", () => {
      const state = createInitialState("app");
      (state as any).step = "invalid";
      expect(() => validate(state)).toThrow("Invalid step");
    });

    it("rejects invalid status", () => {
      const state = createInitialState("app");
      (state as any).status = "banana";
      expect(() => validate(state)).toThrow("Invalid status");
    });

    it("rejects invalid reason (non-null)", () => {
      const state = createInitialState("app");
      (state as any).reason = "bad_reason";
      expect(() => validate(state)).toThrow("Invalid reason");
    });

    it("accepts null reason", () => {
      const state = createInitialState("app");
      state.reason = null;
      expect(() => validate(state)).not.toThrow();
    });

    it("accepts valid reason", () => {
      const state = createInitialState("app");
      state.reason = "needs_clarification";
      expect(() => validate(state)).not.toThrow();
    });
  });

  describe("read/write round-trip", () => {
    it("writes and reads back identical state", () => {
      const original = createInitialState("round-trip-app");
      original.story = "US-001";
      original.step = "impl";
      original.attempt = 3;
      original.status = "failing";
      original.reason = "constitution_violation";

      writeState(tempDir, original);
      const loaded = readState(tempDir);

      expect(loaded).toEqual(original);
    });

    it("creates .ai/ directory if missing", () => {
      const state = createInitialState("new-project");
      writeState(tempDir, state);
      const loaded = readState(tempDir);
      expect(loaded.project).toBe("new-project");
    });

    it("throws when reading non-existent STATE.json", () => {
      expect(() => readState(tempDir)).toThrow("STATE.json not found");
    });
  });

  describe("initState", () => {
    it("creates new state file", () => {
      const { created, state } = initState(tempDir, "init-app");
      expect(created).toBe(true);
      expect(state.project).toBe("init-app");
    });

    it("skips if already exists", () => {
      initState(tempDir, "init-app");
      const { created, state } = initState(tempDir, "different-name");
      expect(created).toBe(false);
      expect(state.project).toBe("init-app"); // original preserved
    });
  });

  describe("isTimedOut", () => {
    it("returns false when not running", () => {
      const state = createInitialState("app");
      expect(isTimedOut(state)).toBe(false);
    });

    it("returns false when within timeout", () => {
      const state = createInitialState("app");
      state.status = "running";
      state.dispatched_at = new Date().toISOString();
      state.timeout_min = 10;
      expect(isTimedOut(state)).toBe(false);
    });

    it("returns true when past timeout", () => {
      const state = createInitialState("app");
      state.status = "running";
      state.dispatched_at = new Date(Date.now() - 15 * 60_000).toISOString();
      state.timeout_min = 10;
      expect(isTimedOut(state)).toBe(true);
    });
  });

  describe("isMaxedOut", () => {
    it("returns true at max", () => {
      const state = createInitialState("app");
      state.attempt = 5;
      state.max_attempts = 5;
      expect(isMaxedOut(state)).toBe(true);
    });

    it("returns false below max", () => {
      const state = createInitialState("app");
      state.attempt = 2;
      state.max_attempts = 5;
      expect(isMaxedOut(state)).toBe(false);
    });
  });

  describe("markRunning", () => {
    it("sets status and timestamp", () => {
      const state = createInitialState("app");
      const running = markRunning(state);
      expect(running.status).toBe("running");
      expect(running.dispatched_at).toBeTruthy();
      expect(running.completed_at).toBeNull();
      expect(running.reason).toBeNull();
    });

    it("does not mutate original", () => {
      const state = createInitialState("app");
      markRunning(state);
      expect(state.status).toBe("pending");
    });
  });

  describe("markCompleted", () => {
    it("sets status and timestamp", () => {
      const state = markRunning(createInitialState("app"));
      const done = markCompleted(state, "pass");
      expect(done.status).toBe("pass");
      expect(done.completed_at).toBeTruthy();
    });

    it("sets reason on failure", () => {
      const state = markRunning(createInitialState("app"));
      const failed = markCompleted(state, "failing", "needs_clarification");
      expect(failed.status).toBe("failing");
      expect(failed.reason).toBe("needs_clarification");
    });
  });
});
