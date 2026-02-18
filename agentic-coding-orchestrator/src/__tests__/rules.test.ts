import { describe, it, expect } from "vitest";

import {
  STEP_RULES,
  BOOTSTRAP_RULE,
  getRule,
  resolvePaths,
  getDispatchMode,
  getFailTarget,
  getStepSequence,
} from "../rules";

describe("rules", () => {
  describe("STEP_RULES completeness", () => {
    const expectedSteps = [
      "bdd",
      "sdd-delta",
      "contract",
      "review",
      "scaffold",
      "impl",
      "verify",
      "update-memory",
    ];

    it("has rules for all micro-waterfall steps", () => {
      for (const step of expectedSteps) {
        expect(STEP_RULES).toHaveProperty(step);
      }
    });

    it("every step has required fields", () => {
      for (const [name, rule] of Object.entries(STEP_RULES)) {
        expect(rule.display_name, `${name}.display_name`).toBeTruthy();
        expect(rule.next_on_pass, `${name}.next_on_pass`).toBeTruthy();
        expect(rule.on_fail, `${name}.on_fail`).toHaveProperty("default");
        expect(rule.max_attempts, `${name}.max_attempts`).toBeGreaterThan(0);
        expect(typeof rule.requires_human).toBe("boolean");
        expect(rule.step_instruction, `${name}.step_instruction`).toBeDefined();
      }
    });

    it("next_on_pass forms a valid chain ending at done", () => {
      let current = "bdd";
      const visited = new Set<string>();

      while (current !== "done") {
        if (visited.has(current)) {
          throw new Error(`Cycle detected at step: ${current}`);
        }
        visited.add(current);
        const rule = STEP_RULES[current as keyof typeof STEP_RULES];
        current = rule.next_on_pass;
      }

      // Should have visited all steps
      expect(visited.size).toBe(expectedSteps.length);
    });
  });

  describe("BOOTSTRAP_RULE", () => {
    it("has next_on_pass = bdd", () => {
      expect(BOOTSTRAP_RULE.next_on_pass).toBe("bdd");
    });

    it("has max_attempts = 1", () => {
      expect(BOOTSTRAP_RULE.max_attempts).toBe(1);
    });
  });

  describe("getRule", () => {
    it("returns bootstrap rule", () => {
      expect(getRule("bootstrap")).toBe(BOOTSTRAP_RULE);
    });

    it("returns step rule for impl", () => {
      expect(getRule("impl").display_name).toBe("Implementation");
    });

    it("throws for done", () => {
      expect(() => getRule("done")).toThrow("No rule for");
    });
  });

  describe("resolvePaths", () => {
    it("replaces {story} placeholder", () => {
      const paths = ["docs/bdd/US-{story}.md", "docs/sdd.md"];
      const resolved = resolvePaths(paths, "US-005");
      expect(resolved).toEqual(["docs/bdd/US-US-005.md", "docs/sdd.md"]);
    });

    it("handles multiple placeholders in one path", () => {
      const paths = ["{story}/{story}.md"];
      const resolved = resolvePaths(paths, "US-001");
      expect(resolved).toEqual(["US-001/US-001.md"]);
    });

    it("handles empty array", () => {
      expect(resolvePaths([], "US-001")).toEqual([]);
    });
  });

  describe("getDispatchMode", () => {
    it("S → single", () => {
      expect(getDispatchMode("S")).toBe("single");
    });

    it("L → team", () => {
      expect(getDispatchMode("L")).toBe("team");
    });

    it("M with 0 parallel → single", () => {
      expect(getDispatchMode("M", 0)).toBe("single");
    });

    it("M with 2+ parallel → team", () => {
      expect(getDispatchMode("M", 2)).toBe("team");
    });

    it("unknown → single", () => {
      expect(getDispatchMode("X")).toBe("single");
    });
  });

  describe("getFailTarget", () => {
    it("routes constitution_violation from impl to sdd-delta", () => {
      expect(getFailTarget("impl", "constitution_violation")).toBe("sdd-delta");
    });

    it("routes needs_clarification from impl to review", () => {
      expect(getFailTarget("impl", "needs_clarification")).toBe("review");
    });

    it("routes null reason from impl to impl (retry)", () => {
      expect(getFailTarget("impl", null)).toBe("impl");
    });

    it("routes null reason from bdd to bdd (retry)", () => {
      expect(getFailTarget("bdd", null)).toBe("bdd");
    });

    it("routes needs_clarification from review to bdd", () => {
      expect(getFailTarget("review", "needs_clarification")).toBe("bdd");
    });
  });

  describe("getStepSequence", () => {
    it("returns 8 steps in order", () => {
      const seq = getStepSequence();
      expect(seq).toHaveLength(8);
      expect(seq[0]).toBe("bdd");
      expect(seq[seq.length - 1]).toBe("update-memory");
    });
  });
});
