# ACO Handoff — 2026-02-27

## Just Completed: ACO v0.8.0

Implemented three new commands for FB-009 (Review → Triage → Re-entry).

### New Functions (dispatch.ts)

1. **`reopen(projectRoot, targetStep, {humanNote?})`** → `ActionResult`
   - Stateful: resets a "done" story back to target step
   - Guards: NOT_DONE, REOPEN_TO_DONE, INVALID_TARGET
   - Pattern: follows rollback() but guards on `step === "done"`

2. **`review(projectRoot)`** → `{ type: "review_prompt", prompt, fw_lv }`
   - Stateless: generates Review Session prompt, no STATE mutation
   - Adaptive: 3 prompt levels based on detectFramework (0/1/2)
   - Full ACF (lv2): 5 checks — Code Review, Spec-Code Coherence, Regression, Security Scan, Memory Audit
   - Non-ACF (lv0): 3 checks — Code Review, Test Check, Security Scan

3. **`triage(projectRoot)`** → `{ type: "triage_prompt", prompt, issues[], fw_lv }` | error
   - Stateless: reads PROJECT_MEMORY.md ISSUES, generates triage plan
   - Parses `- [ ]` items under `## ISSUES` header, filters out `- [x]`
   - Human-gated: prompt asks executor to classify A/B/C (REOPEN/NEW US/DISMISS)
   - Errors: NO_MEMORY, NO_ISSUES

### Files Modified

| File | Changes |
|------|---------|
| `src/dispatch.ts` | +reopen(), +review(), +triage(), +buildReviewPrompt(), +buildTriagePrompt(), +parseIssuesFromMemory() |
| `src/cli.ts` | +reopen/review/triage CLI commands, updated usage header |
| `src/auto.ts` | +review/triage/reopen Intent types, classifier patterns, handler cases |
| `src/index.ts` | +reopen, review, triage exports |
| `package.json` | 0.7.3 → 0.8.0 |
| `TODO.md` | Updated: FB-009 items marked done, pending items listed |
| `test/reopen.test.js` | 16 tests (guards, state reset, rule adoption, human note, dispatch integration) |
| `test/review.test.js` | 10 tests (fw levels, prompt content, stateless) |
| `test/triage.test.js` | 10 tests (error cases, parsing, prompt content, stateless) |

### Test Results

- **New tests**: 36 pass, 0 fail
- **All tests** (`test/*.test.js`): 192 pass, 0 fail
- **vitest tests** (`src/__tests__/`): not runnable in this env (needs vitest), run locally with `npm test`

### Not Yet Committed

All v0.8.0 changes are uncommitted. Ready to commit when you say so.

### Pending Items (Future)

- [ ] Guardrails: failed verify after reopen → auto-escalate rollback one level deeper
- [ ] history.md entry on reopen (currently only appendLog)
- [ ] Review Session auto-triggered after N stories complete

## ACF Status (from earlier in this session)

All ACF framework docs were updated and committed (`f9ba769`):

- **FB-009** (Review → Triage → Re-entry) — incorporated
- **FB-010** (Framework Migration) — incorporated
- **FB-011** (Security Principle) — incorporated
- Framework versions: Lifecycle v0.9, Protocol v0.13, Templates v0.12, Refinement v0.12
- Skills updated: SKILL.md + workflow.md
