# Agentic Coding Orchestrator

Deterministic orchestrator core for the [Agentic Coding Framework](https://github.com/MaWeiChi/Agentic-Coding-Framework). Drives User Story pipelines and ad-hoc tasks with zero LLM tokens — all decisions are table lookups and template fills. Designed to be called by OpenClaw (or any LLM-powered conversation layer).

## Architecture

```
src/
  state.ts      STATE.json types, read/write, validation
  rules.ts      Step transition rules table (pure data)
  dispatch.ts   State machine, prompt builder, HANDOFF parser
  index.ts      Unified public API
  cli.ts        CLI entry point
bin/
  dispatch-claude-code.sh   Invoke Claude Code CLI with dispatch prompt
  notify-agi.sh             Post-hook: parse HANDOFF → update STATE
```

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

### CLI Usage

```bash
# Initialize a new project
npx ts-node src/cli.ts init ./my-project my-app

# Start a story
npx ts-node src/cli.ts start-story ./my-project US-001

# Dispatch next step (prints prompt to stdout)
npx ts-node src/cli.ts dispatch ./my-project

# Apply HANDOFF.md results after executor exits
npx ts-node src/cli.ts apply-handoff ./my-project

# Approve review step
npx ts-node src/cli.ts approve ./my-project
npx ts-node src/cli.ts approve ./my-project "Looks good, rename the module"

# Reject review step
npx ts-node src/cli.ts reject ./my-project needs_clarification "What does fast mean?"

# Custom task (any ad-hoc instruction)
npx ts-node src/cli.ts start-custom ./my-project "Replace all console.log with pino logger"
npx ts-node src/cli.ts dispatch ./my-project

# Query project status (for OpenClaw / conversation layer)
npx ts-node src/cli.ts query ./my-project
npx ts-node src/cli.ts detect ./my-project
npx ts-node src/cli.ts list-projects ./workspace
```

### Shell Scripts (Claude Code Integration)

```bash
# Full dispatch → Claude Code → apply cycle
bin/dispatch-claude-code.sh ./my-project

# Post-hook only (parse HANDOFF, update STATE)
bin/notify-agi.sh ./my-project
```

## Two Pipelines

**Story Pipeline** (micro-waterfall): `bdd → sdd-delta → contract → review → scaffold → impl → verify → update-memory → done`

**Custom Pipeline** (ad-hoc): `custom → update-memory → done`

The Story pipeline enforces BDD/SDD/Review gates for new features. The Custom pipeline is a passthrough for any instruction — refactoring, code review, bug fixes, DevOps, etc. See `SKILL.md` for the full use case catalog.

## OpenClaw Integration

The orchestrator is designed to be called by OpenClaw (a low-cost LLM conversation layer). OpenClaw reads `SKILL.md` to learn the API, then classifies user requests:

- **Questions** (status, tests, progress) → call `queryProjectStatus()` or read files directly → zero cost
- **Commands** (approve, reject, start) → call orchestrator functions directly → zero cost
- **Code tasks** → `startStory()` or `startCustom()` → `dispatch()` → Claude Code → executor cost

```typescript
import {
  initState, dispatch, applyHandoff, startStory, startCustom,
  queryProjectStatus, detectFramework, listProjects,
} from "@agentic-coding/orchestrator-core";

// OpenClaw: "how's the project?"
const status = queryProjectStatus(projectRoot);

// OpenClaw: "start story US-001"
startStory(projectRoot, "US-001");
const result = dispatch(projectRoot);

// OpenClaw: "refactor the auth module"
startCustom(projectRoot, "Refactor auth module into separate package");
const result = dispatch(projectRoot);

// OpenClaw: "list all projects"
const projects = listProjects(workspaceRoot);
```

## Three-File Protocol

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `.ai/STATE.json` | Orchestrator | Orchestrator | Machine state (step, attempt, status) |
| `.ai/HANDOFF.md` | Executor | Orchestrator | Bridge: YAML front matter + markdown body |
| `PROJECT_MEMORY.md` | Executor | Any session | Cross-session human-readable memory |

The orchestrator never touches `PROJECT_MEMORY.md`. The executor never touches `STATE.json`. `HANDOFF.md` is the bridge.

## Related

- [Agentic Coding Framework](https://github.com/MaWeiChi/Agentic-Coding-Framework) — The full framework with Protocol, Lifecycle, Templates
- [Protocol Reference](Skills/agentic-coding-orchestrator/references/protocol.md) — Detailed module-level documentation

## License

MIT
