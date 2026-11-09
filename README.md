# AI Manager

AI Manager (`aim`) is a zero-dependency CLI and live web dashboard to monitor AI coding agents and subagents across multiple tools in real time:

- **Supported AI Tools**: **Claude Code**, **Antigravity (AGY)**, **OpenAI Codex CLI**, **Cursor**, **Windsurf (Cascade)**, and **Aider**.
- **Multi-Tool Monitoring**: Automatically detects active agents from multiple AI tools working on the same project simultaneously.
- **Agent & Subagent Trees**: Shows sessions, subagent hierarchies, tool badges, status (`running`, `idle`, `completed`, `failed`), durations, and active activities.
- **Task Tracking**: Tracks task lists across tools (`TodoWrite`, `TaskCreate`, `update_plan`, desktop plans) and subagent delegations. Grouped into Pending, In progress, Completed, and Failed.
- **File Touch Analysis**: Records every file read, edited, and written across all agents with modification counts.
- **Turn Artifacts**: Automatically writes detailed work summaries (JSON and Markdown) upon turn completion.
- **Live Web Dashboard & TUI**: Real-time SSE streaming web UI (with dark/light themes and filtering) and full terminal UI.

Requires Node.js 18 or later. Zero external npm dependencies.

## Install

```bash
git clone https://github.com/your-org/ai-manager.git
cd ai-manager
npm link
```

`npm link` provides the `aim` and `ai-manager` commands globally. You can also run `node bin/aim.js <command>`.

## Quick Start

1. Go to any project where you use an AI coding tool:
```bash
cd /path/to/my-project
```

2. Start the live dashboard:
```bash
aim dashboard --open
```

3. Or inspect from the terminal:
```bash
aim status
aim watch
```

4. To try it immediately with simulated agents:
```bash
aim demo --open
```

## Supported AI Tools & Transcript Sources

AI Manager incrementally parses local transcripts using byte offsets with millisecond refreshes:

| Tool | Transcript Location | Subagents |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<encoded-path>/<session>.jsonl` | Yes (`subagents/`) |
| **Antigravity (AGY)** | `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` | Yes (`subagents/`) |
| **OpenAI Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Yes (linked threads) |
| **Cursor** | `~/.cursor/projects/<encoded>/agent-transcripts/<id>/` | Yes (`subagents/`) |
| **Windsurf (Cascade)** | `~/.windsurf/transcripts/<trajectory_id>.jsonl` | Single session |
| **Aider** | `<project>/.aider.chat.history.md` | Single session |

### Status States

| Status | Meaning |
|---|---|
| `running` | The agent has an active turn and recent activity (running tools or thinking). |
| `idle` | Waiting for user input, permission confirmation, or inactive for a few minutes. |
| `completed` | Subagent finished its delegation, or main session completed work. |
| `failed` | Turn stopped due to API error, failed tool, or user interrupt. |

## CLI Commands

| Command | What it does |
|---|---|
| `aim status` | Summary, multi-tool agent tree, and recent activity (default) |
| `aim watch` | Live terminal view, auto-refreshes every second |
| `aim agents` | Detailed agent tree with tool badges, status, and current task |
| `aim tasks` | All tasks with status and owner agent |
| `aim files` | Files read, edited, and written across all agents |
| `aim activity` | Recent tool calls across all AI tools |
| `aim artifacts` | Work history reports |
| `aim artifact <id>` | View one artifact report as Markdown (`--json` for JSON) |
| `aim scan` | Parse transcripts now and write any missing artifacts |
| `aim dashboard` | Start the real-time web dashboard |
| `aim demo` | Launch dashboard with simulated parallel agents |
| `aim hooks install\|uninstall\|status` | Manage optional Claude Code hooks |

### Options

- `--project <dir>`: Project directory (defaults to nearest `.git`, `.claude`, `.gemini`, or `.codex` folder)
- `--provider <tools>`: Filter AI tools (e.g. `--provider claude,antigravity,codex`)
- `--all`: Include ended sessions and full history
- `--max-age <hours>`: Ignore agents idle longer than this (default: 48, `0` = no limit)
- `--port <n>`: Web dashboard port (default: 4777)
- `--lan`: Listen on all interfaces with access tokens
- `--share`: Open a public HTTPS tunnel (via `cloudflared` or `ssh`)
- `--json`: Output machine-readable JSON

## Dashboard & Sharing

```bash
aim dashboard                 # http://localhost:4777/ (local machine)
aim dashboard --lan           # http://<lan-ip>:4777/?token=... (local network)
aim dashboard --share         # https://*.trycloudflare.com/?token=... (public tunnel)
aim dashboard --port 5000 --open
```

Dashboard views:
- **Agents**: Tree view grouping subagents under sessions with AI tool badges, status pills, task checklists, and file chips. Click any row for deep drill-down drawer.
- **Tasks**: Kanban board with Pending, In Progress, Completed, and Failed columns.
- **Files**: Interactive table of all files touched with read/edit/write counts and responsible agents.
- **Activity**: Unified real-time event feed across all tools.
- **Artifacts**: Markdown reports for each finished turn with diffs, summaries, and tool usage metrics.

## License

MIT
