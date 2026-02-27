# ─── ACO Makefile ──────────────────────────────────────────────────────────────
#
# Usage:
#   make test       # run all tests (node:test, zero deps)
#   make build      # compile TypeScript → dist/
#   make all        # test then build (default)
#   make test-p0    # run only P0 (critical) tests
#   make test-p1    # run only P1 tests
#   make test-p2    # run only P2 tests
#   make clean      # remove dist/
#
# CI / pre-build: `make` (= make all) ensures tests pass before compiling.
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: all test test-p0 test-p1 test-p2 test-rollback test-integ test-hooklog test-cli build clean

all: test build

# ─── Test ─────────────────────────────────────────────────────────────────────
# Uses node:test (built-in, zero deps). Requires dist/ to be current.
# Rebuilds dist/ automatically before running tests.

test: build-quiet
	@echo "══════════════════════════════════════════════════════════"
	@echo "  Running ALL tests (P0 + P1 + P2 + rollback + integ + hooklog + cli)"
	@echo "══════════════════════════════════════════════════════════"
	node --test test/dispatch-p0.test.js test/dispatch-p1.test.js test/dispatch-p2.test.js test/rollback.test.js test/integration-real-data.test.js test/hook-log.test.js test/cli-output.test.js

test-p0: build-quiet
	@echo "══ P0: Critical (stale HANDOFF, commit step, integration) ══"
	node --test test/dispatch-p0.test.js

test-p1: build-quiet
	@echo "══ P1: peek, rollback, startStory guards, timeout, prereqs ══"
	node --test test/dispatch-p1.test.js

test-p2: build-quiet
	@echo "══ P2: classify, YAML edges, rules, startCustom, detect ══"
	node --test test/dispatch-p2.test.js

test-rollback: build-quiet
	@echo "══ Rollback: exhaustive rollback coverage ══"
	node --test test/rollback.test.js

test-integ: build-quiet
	@echo "══ Integration: real project lifecycle replays ══"
	node --test test/integration-real-data.test.js

test-hooklog: build-quiet
	@echo "══ Hook Log: appendLog + core function logging ══"
	node --test test/hook-log.test.js

test-cli: build-quiet
	@echo "══ CLI Output: <task-meta> in dispatch/peek stdout ══"
	node --test test/cli-output.test.js

# ─── Build ────────────────────────────────────────────────────────────────────

build:
	@echo "Building TypeScript → dist/"
	npx tsc

# Internal: build without banner (for test dependency)
build-quiet:
	@npx tsc

# ─── Clean ────────────────────────────────────────────────────────────────────

clean:
	rm -rf dist/

# ─── Publish ──────────────────────────────────────────────────────────────────
adduser:
	npm adduser

publish:
	npm run build && npm publish --access public 