# Agentic Coding Orchestrator

Deterministic orchestrator core for the [Agentic Coding Framework](https://github.com/MaWeiChi/Agentic-Coding-Framework). Drives the micro-waterfall pipeline (BDD → SDD → Contract → Review → Scaffold → Impl → Verify → Update Memory) with zero LLM tokens — all decisions are table lookups and template fills.

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
```

### Shell Scripts (Claude Code Integration)

```bash
# Full dispatch → Claude Code → apply cycle
bin/dispatch-claude-code.sh ./my-project

# Post-hook only (parse HANDOFF, update STATE)
bin/notify-agi.sh ./my-project
```

## Integration Pattern

The orchestrator is designed as a library. Import it into your own main loop:

```typescript
import {
  initState, dispatch, applyHandoff, runPostCheck,
  approveReview, startStory,
} from "@agentic-coding/orchestrator-core";
import { execSync } from "child_process";

initState(projectRoot, "my-app");
startStory(projectRoot, "US-001");

while (true) {
  const result = dispatch(projectRoot);
  switch (result.type) {
    case "dispatched":
      spawnExecutor(projectRoot, result.prompt);
      runPostCheck(projectRoot, execSync);
      applyHandoff(projectRoot);
      break;
    case "needs_human":
      // Wait for human, then approveReview() or rejectReview()
      break;
    case "done":
      console.log(result.summary);
      return;
  }
}
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
