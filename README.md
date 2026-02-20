# Agentic Coding Orchestrator

Zero-token orchestrator for the [Agentic Coding Framework](https://github.com/MaWeiChi/Agentic-Coding-Framework). Drives User Story pipelines and ad-hoc tasks with deterministic table lookups — no LLM tokens. Designed for OpenClaw or any LLM conversation layer to call.

## Installation

```bash
npm install @agentic-coding-framework/orchestrator-core
```

Global CLI:

```bash
npm install -g @agentic-coding-framework/orchestrator-core
orchestrator status ./my-project
```

## Quick Start

```typescript
import {
  dispatch, startStory, startCustom, applyHandoff,
  queryProjectStatus, detectFramework, listProjects,
} from "@agentic-coding-framework/orchestrator-core";

// Start a story (micro-waterfall: bdd → sdd → contract → review → scaffold → impl → verify → done)
startStory(projectRoot, "US-001");
const result = dispatch(projectRoot);
// result = { type: "dispatched", step: "bdd", attempt: 1, prompt: "...", fw_lv: 2 }

// Custom task (any ad-hoc instruction)
startCustom(projectRoot, "Refactor auth module into separate package");
const result = dispatch(projectRoot);
// result = { type: "dispatched", step: "custom", attempt: 1, prompt: "...", fw_lv: 0 }

// Query (zero cost)
queryProjectStatus(projectRoot);   // status, step, tests, memory summary
detectFramework(projectRoot);      // fw level 0/1/2
listProjects(workspaceRoot);       // all projects in workspace
```

### `fw_lv` — Framework Level

`dispatch()` returns `fw_lv` so the caller knows how much context CC has:

| `fw_lv` | Meaning |
|---------|---------|
| `0` | No framework — CC works solo, reads source directly |
| `1` | Partial — some framework docs exist |
| `2` | Full framework — complete context (SDD, Constitution, Memory) |

### Auto-Initialization

`startStory()` and `startCustom()` auto-create `.ai/STATE.json` if missing. Project name is inferred from `package.json` / `go.mod` / directory name. Any project is a valid target.

## CLI

```bash
orchestrator init ./project my-app
orchestrator start-story ./project US-001
orchestrator start-custom ./project "Replace console.log with pino logger"
orchestrator dispatch ./project          # prints prompt to stdout
orchestrator apply-handoff ./project     # parse HANDOFF.md → update STATE
orchestrator approve ./project
orchestrator reject ./project needs_clarification "What does fast mean?"
orchestrator query ./project
orchestrator detect ./project
orchestrator list-projects ./workspace
```

## CC Integration (Shell Scripts)

### Setup

```bash
# Copy hooks
cp bin/dispatch-claude-code.sh ~/.claude/hooks/
cp bin/notify-agi.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh

# Register in ~/.claude/settings.json (or merge from hooks/claude-settings.json)
```

### Dispatch

> **Note:** The script runs Claude Code in headless mode (`-p`), which cannot
> prompt for permissions interactively. It defaults to
> `--dangerously-skip-permissions` (a standalone flag, **not** a
> `--permission-mode` value) unless you explicitly pass
> `--permission-mode <mode>`. Also add `"skipDangerousModePermissionPrompt": true`
> to your `~/.claude/settings.json` to suppress the WARNING dialog.

```bash
# From orchestrator (auto-generates prompt from STATE.json)
bin/dispatch-claude-code.sh --from-orchestrator ./project

# Direct prompt
bin/dispatch-claude-code.sh -p "Fix the race condition in WebSocket reconnection"

# With notification (WhatsApp, Telegram, etc.)
bin/dispatch-claude-code.sh \
  --from-orchestrator ./project \
  --channel whatsapp \
  --notify-target "+886912345678" \
  -n "fix-websocket"

# Override permission mode (e.g. for CI with pre-approved tool list)
bin/dispatch-claude-code.sh \
  --permission-mode plan \
  --allowed-tools "Read,Write,Edit,Bash" \
  -p "Add unit tests for auth module"
```

### Notification Flow

When CC finishes, `notify-agi.sh` (Stop hook) automatically:

1. Reads `task-meta.json` for channel config
2. Pushes result via `openclaw message send --channel <channel>`
3. Writes `pending-wake.json` as fallback for polling

Supports any channel: WhatsApp, Telegram, LINE, etc.

## Two Pipelines

**Story** (micro-waterfall): `bdd → sdd-delta → contract → review → scaffold → impl → verify → update-memory → done`

**Custom** (passthrough): `custom → update-memory → done`

Story enforces BDD/SDD/Review gates. Custom is a passthrough for anything — refactor, code review, bug fix, DevOps, docs, testing, migration, performance, security, cleanup.

## Three-File Protocol

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `.ai/STATE.json` | Orchestrator | Orchestrator | Machine state (step, attempt, status) |
| `.ai/HANDOFF.md` | CC (executor) | Orchestrator | Bridge: YAML front matter + markdown body |
| `PROJECT_MEMORY.md` | CC (executor) | Any session | Cross-session human-readable memory |

## Architecture

```
agentic-coding-orchestrator/src/
  state.ts      STATE.json types, read/write, validation
  rules.ts      Step transition rules table (pure data)
  dispatch.ts   State machine, prompt builder, HANDOFF parser
  index.ts      Public API
  cli.ts        CLI entry point
bin/
  dispatch-claude-code.sh   Invoke CC with dispatch prompt
  notify-agi.sh             Stop hook: collect output → notify → wake AGI
hooks/
  claude-settings.json      CC hook registration template
Skills/
  agentic-coding-orchestrator/SKILL.md   Full reference for OpenClaw LLM
```

## OpenClaw Integration

OpenClaw (low-cost LLM) reads `SKILL.md` to learn the full API. Classification:

- **Questions** → read files / call query functions → free
- **Commands** (approve, reject, start) → call orchestrator functions → free
- **Code tasks** → `startCustom()` or `startStory()` → `dispatch()` → CC → token cost

**CRITICAL RULE**: When user says "用 CC" / "use CC" (case-insensitive), MUST use orchestrator flow regardless of project state.

## Acknowledgments

- [claude-code-hooks](https://github.com/win4r/claude-code-hooks) by [@win4r](https://github.com/win4r) — Shell hook pattern reference. Our `dispatch-claude-code.sh` and `notify-agi.sh` are inspired by this project's clean, minimal hook design.

## Related

- [Agentic Coding Framework](https://github.com/MaWeiChi/Agentic-Coding-Framework) — Full framework with Protocol, Lifecycle, Templates

## License

MIT
