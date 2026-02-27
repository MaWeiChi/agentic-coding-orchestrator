# ACO TODO

## Completed in v0.8.0 — FB-009: Review → Triage → Re-entry

- [x] `review` command — generates on-demand Review Session prompt (5 checks: Code Review, Spec-Code Coherence, Regression, Security Scan, Memory Audit)
- [x] `reopen` command — reopens completed US at specified step (STATE reset, preserves story/project)
- [x] `triage` command — reads unfixed ISSUES from PROJECT_MEMORY.md, generates triage plan (human-gated)
- [x] Review Session works on non-ACF projects (fw_lv 0/1/2 adaptive prompts)
- [x] ISSUES parsing supports `linked: US-XXX` format
- [x] auto.ts classifier extended: review, triage, reopen intents
- [x] CLI: `orchestrator review`, `orchestrator reopen`, `orchestrator triage`
- [x] Tests: reopen.test.js (16 tests), review.test.js (10 tests), triage.test.js (10 tests)

## Pending — Future iterations

- [ ] Guardrails: failed verify after reopen → auto-escalate rollback one level deeper
- [ ] history.md entry on reopen (currently only appendLog)
- [ ] Review Session auto-triggered after N stories complete (configurable)
