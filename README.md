# AI Manager for Claude Code

AI Manager is a CLI and a live web dashboard. It shows what every Claude Code agent and subagent in a project does:

- **Agent monitoring**: the number of sessions and subagents, and the name, type, status (`running`, `idle`, `completed`, `failed`) and current task of each. It also shows the files each agent reads, edits and writes.
- **Task tracking**: task lists from `TodoWrite`, `TaskCreate`/`TaskUpdate` and the desktop app's plan, plus each delegated subagent as a task. Each task is `pending`, `in progress`, `completed` or `failed`.
- **Artifacts**: when an agent finishes a turn, AI Manager writes a report (JSON and Markdown). The report has a summary, the modified files, the files read, the tasks, the subagents, the tool usage and the issues. All reports stay in a history.
- **Web dashboard**: live updates (Server-Sent Events), and local, LAN or public URLs.

It has no dependencies. It needs Node.js 18 or later.

## Install

```bash
cd "D:\agent manager"
npm link
```

`npm link` makes the `aim` and `ai-manager` commands available everywhere. You can also run `node "D:\agent manager\bin\aim.js" <command>`.

## Quick start

1. Go to a project folder where you use Claude Code.
2. Run the dashboard:

```bash
aim dashboard --open
```

3. To try it without real agents, run the demo. It simulates a session with 3 parallel subagents, and one of them fails:

```bash
aim demo --open
```

## How it works

AI Manager reads the transcripts that Claude Code writes for each project:

```
~/.claude/projects/<encoded project path>/<session>.jsonl
~/.claude/projects/<encoded project path>/<session>/subagents/agent-<id>.jsonl  (+ .meta.json)
```

It reads each file incrementally (by byte offset), so a refresh takes a few milliseconds. No setup is necessary. Agents that ran before you installed AI Manager also show.

Status rules:

| Status | Meaning |
|---|---|
| `running` | The agent has an open turn and wrote to its transcript recently (3 min, or 10 min while a tool runs). |
| `idle` | A main session waits for the user or for a permission, or an agent has no activity for some minutes. |
| `completed` | A subagent finished, or a main session ended (hook `SessionEnd`, or 30 min with no activity). |
| `failed` | The turn stopped with an API error, a failed subagent result, or a user interrupt. A subagent that stopped without a result is also `failed`. |

### Optional hooks

Hooks make two things more exact: artifacts are written the moment an agent stops (also when no dashboard runs), and the dashboard shows "waiting for permission" and the true session end.

```bash
aim hooks install     # writes .claude/settings.local.json in the project
aim hooks status
aim hooks uninstall   # removes only the AI Manager entries
```

Restart the Claude Code sessions in the project after you install the hooks. The hook command never prints and always exits with code 0, so it cannot block Claude Code.

## Commands

| Command | What it does |
|---|---|
| `aim status` | Summary, agent tree and recent activity (default command) |
| `aim watch` | Live terminal view |
| `aim agents` | Agents and subagents as a tree |
| `aim tasks` | All tasks with status and owner |
| `aim files` | Files that agents touched, with read/edit/write counts |
| `aim activity` | Recent tool calls of all agents |
| `aim artifacts` | Artifact history |
| `aim artifact <id>` | Print one artifact as Markdown (`--json` for JSON) |
| `aim scan` | Read transcripts now and write missing artifacts (`--all` for full history) |
| `aim dashboard` | Start the web dashboard |
| `aim demo` | Dashboard with simulated agents |
| `aim hooks install\|uninstall\|status` | Manage the optional hooks |

Common options: `--project <dir>`, `--all` (include ended sessions and full history), `--max-age <hours>` (default 48, `0` = no limit), `--json`.

## Dashboard and URLs

```bash
aim dashboard                 # http://localhost:4777/  (this computer only)
aim dashboard --lan           # also http://<lan-ip>:4777/?token=...
aim dashboard --share         # also a public https URL, with a token
aim dashboard --port 5000 --open
```

The dashboard has 5 tabs:

- **Agents**: sessions with their subagents in a tree. Each row shows the status, current task, task progress, files, duration, tool calls and issues. Click a row for the details: the prompt, the result, the task checklist, the files, the tools, the issues, the recent activity and the artifacts.
- **Tasks**: a board with the columns Pending, In progress, Completed and Failed.
- **Files**: each touched file, the agents that touched it, and the read/edit/write counts.
- **Activity**: a live feed of the tool calls of all agents.
- **Artifacts**: the history of finished work. Click a row to read the report or to download it as `.md`.

**Public URL.** `--share` uses `cloudflared` (`*.trycloudflare.com`) when it is installed. If not, it uses `ssh` to `localhost.run` (`*.lhr.life`). With `--lan` or `--share`, AI Manager makes a random token, and every URL needs it.

> **Warning:** The dashboard shows prompts, file paths and agent output. Share the public URL only with people who may see that data. Stop the tunnel with Ctrl+C.

## Artifacts

Artifacts are in `<project>/.ai-manager/artifacts/`:

- `<id>.json`: structured data
- `<id>.md`: a readable report
- `index.json`: the history index

The artifact ID is `<agent id prefix>-t<turn>`. Add `.ai-manager/` to your `.gitignore`.

Environment variables: `AIM_CLAUDE_DIR` (Claude config dir, default `~/.claude`), `AIM_STORE_DIR` (artifact and event store, default `<project>/.ai-manager`).

## Tests

```bash
npm test
```

## Files

```
bin/aim.js          CLI
src/monitor.js      transcript reader, agent model, status rules, snapshot
src/artifacts.js    artifact store and Markdown reports
src/hooks.js        hook install/uninstall and the hook handler
src/server.js       HTTP server, SSE stream, token check
src/dashboard.html  the dashboard page (no build step)
src/share.js        public URL through cloudflared or ssh
src/tui.js          terminal tables and views
src/demo.js         simulated agent run
```
