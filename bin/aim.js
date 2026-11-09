#!/usr/bin/env node
'use strict';
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Monitor } = require('../src/monitor');
const { findProjectRoot } = require('../src/paths');
const hooks = require('../src/hooks');
const tui = require('../src/tui');
const { c } = tui;
const pkg = require('../package.json');

const HELP = `${c.bold('AI Manager')} ${c.gray('v' + pkg.version)} — monitor Claude Code agents and subagents in a project

${c.bold('Usage')}  aim <command> [options]

${c.bold('Monitor')}
  status                 Summary and agent tree (default command)
  watch                  Live terminal view, refreshes every second
  agents                 Agents and subagents with status and current task
  tasks                  Tasks: pending, in progress, completed, failed
  files                  Files that agents read, edit or write
  activity               Recent tool calls across all agents

${c.bold('Artifacts')}
  artifacts              History of finished tasks and their artifacts
  artifact <id>          Print one artifact (Markdown; --json for JSON)
  scan                   Read all transcripts now and write missing artifacts

${c.bold('Dashboard')}
  dashboard              Start the live web dashboard
    --port <n>           Port (default 4777)
    --lan                Listen on all interfaces and print LAN URLs
    --share              Also open a public URL through a tunnel (cloudflared or ssh)
    --token <t>          Access token (made for you with --lan or --share)
    --open               Open the dashboard in the browser
  demo                   Dashboard with simulated agents (no Claude Code needed)

${c.bold('Hooks')} ${c.gray('(optional: instant artifacts and exact session end / permission waits)')}
  hooks install          Add AI Manager hooks to .claude/settings.local.json
  hooks uninstall        Remove them
  hooks status           Show hook state and the last event

${c.bold('Common options')}
  --project <dir>        Project root (default: nearest folder with .claude/.git)
  --all                  Include ended sessions and full history
  --max-age <hours>      Ignore agents idle for longer than this (default 48, 0 = no limit)
  --json                 Machine-readable output
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (v !== undefined) out[k] = v;
      else if (next !== undefined && !next.startsWith('--') && ['project', 'port', 'token', 'max-age', 'limit', 'interval', 'host', 'tunnel', 'speed'].includes(k)) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function makeMonitor(args, extra = {}) {
  const projectDir = args.project ? path.resolve(args.project) : findProjectRoot();
  const maxAgeHours = args['max-age'] != null ? Number(args['max-age']) : args.all ? 0 : 48;
  const m = new Monitor({ projectDir, maxAgeHours, ...extra });
  m.refresh();
  return m;
}

const print = (s) => process.stdout.write(s + '\n');

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}

async function dashboard(args, monitor, label = '') {
  const { createServer, lanAddresses } = require('../src/server');
  const port = Number(args.port || 4777);
  const lan = !!args.lan;
  const share = !!args.share;
  const token = args.token && args.token !== true ? String(args.token) : (lan || share ? crypto.randomBytes(12).toString('base64url') : null);
  const host = args.host || (lan ? '0.0.0.0' : '127.0.0.1');
  const server = createServer(monitor, { token });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use. Use --port <n>.`) : e));
    server.listen(port, host, resolve);
  });
  const withToken = (base) => (token ? `${base}/?token=${token}` : `${base}/`);
  const local = withToken(`http://localhost:${port}`);
  print(`${c.bold(c.cyan('AI Manager dashboard'))}${label}  ${c.gray(monitor.projectDir)}`);
  print(`  Local:   ${c.bold(local)}`);
  if (lan) for (const ip of lanAddresses()) print(`  LAN:     ${withToken(`http://${ip}:${port}`)}`);
  let tunnel = null;
  if (share) {
    process.stdout.write(c.gray('  Public:  opening a tunnel…\r'));
    try {
      const { startTunnel } = require('../src/share');
      tunnel = await startTunnel(port, args.tunnel);
      print(`  Public:  ${c.bold(c.green(withToken(tunnel.url)))} ${c.gray(`(${tunnel.provider})`)}`);
      print(c.yellow('  Anyone with the public URL and token can see your agent activity. Press Ctrl+C to close it.'));
    } catch (e) {
      print(`  Public:  ${c.red('not available')} — ${e.message}`);
    }
  }
  print(c.gray('  Press Ctrl+C to stop.'));
  if (args.open) openBrowser(local);
  const stop = () => { if (tunnel) tunnel.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function watch(args) {
  const m = makeMonitor(args);
  const every = Math.max(0.5, Number(args.interval || 1)) * 1000;
  const draw = () => {
    m.refresh();
    const out = tui.dashboardText(m.snapshot(), { all: !!args.all, activity: 8 });
    process.stdout.write('\x1b[H\x1b[2J' + out + '\n' + c.gray('\nRefreshing every ' + every / 1000 + 's — Ctrl+C to exit'));
  };
  process.stdout.write('\x1b[?25l');
  const restore = () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); };
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);
  draw();
  setInterval(draw, every);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  if (args.help || cmd === 'help' || args.h) return print(HELP);
  if (args.version || cmd === 'version') return print(pkg.version);

  switch (cmd) {
    case 'hook': return hooks.handle();

    case 'status': {
      const s = makeMonitor(args).snapshot();
      return print(args.json ? JSON.stringify(s, null, 2) : tui.dashboardText(s, { all: !!args.all }));
    }
    case 'watch': return watch(args);
    case 'agents': {
      const s = makeMonitor(args).snapshot();
      return print(args.json ? JSON.stringify(s.agents, null, 2) : `${tui.summaryLine(s)}\n\n${tui.agentTree(s, { all: !!args.all })}`);
    }
    case 'tasks': {
      const s = makeMonitor(args).snapshot();
      return print(args.json ? JSON.stringify(s.tasks, null, 2) : tui.tasksView(s, { all: !!args.all }));
    }
    case 'files': {
      const s = makeMonitor(args).snapshot();
      return print(args.json ? JSON.stringify(s.files, null, 2) : tui.filesView(s));
    }
    case 'activity': {
      const s = makeMonitor(args).snapshot();
      return print(args.json ? JSON.stringify(s.activity, null, 2) : tui.activityView(s, Number(args.limit || 30)));
    }
    case 'artifacts': {
      const m = makeMonitor(args);
      const list = m.artifacts.list();
      return print(args.json ? JSON.stringify(list, null, 2)
        : `${tui.artifactsView(list, Number(args.limit || 25))}\n\n${c.gray(`${list.length} artifacts in ${m.artifacts.dir}`)}`);
    }
    case 'artifact': {
      const id = args._[1];
      if (!id) throw new Error('Usage: aim artifact <id>');
      const m = makeMonitor({ ...args, 'max-age': 0 }, { artifacts: false });
      const list = m.artifacts.list();
      const hit = list.find((a) => a.id === id) || list.find((a) => a.id.startsWith(id));
      const art = hit && m.artifacts.get(hit.id);
      if (!art) throw new Error(`No artifact "${id}". Run "aim artifacts" to see the IDs.`);
      const { markdown, ...json } = art;
      return print(args.json ? JSON.stringify(json, null, 2) : markdown);
    }
    case 'scan': {
      const t = Date.now();
      const m = makeMonitor({ ...args, 'max-age': args.all ? 0 : args['max-age'] });
      const s = m.snapshot();
      return print(`Read ${m.files.size} transcripts in ${Date.now() - t} ms. ${s.summary.total} agents, ${s.summary.artifacts} artifacts in ${m.artifacts.dir}`);
    }
    case 'dashboard': case 'serve': case 'ui':
      return dashboard(args, makeMonitor(args));

    case 'demo': {
      const { startDemo } = require('../src/demo');
      const P = startDemo({ speed: Number(args.speed || 1) });
      const m = new Monitor({ projectDir: P.projectDir, claudeDir: P.claudeDir, maxAgeHours: 0 });
      return dashboard(args, m, c.yellow('  [DEMO: simulated agents]'));
    }

    case 'hooks': {
      const projectDir = args.project ? path.resolve(args.project) : findProjectRoot();
      const sub = args._[1] || 'status';
      if (sub === 'install') {
        const file = hooks.install(projectDir);
        print(`${c.green('✔')} Hooks installed in ${file}`);
        print(c.gray('  Restart Claude Code sessions in this project, or run /hooks in them, to load the new hooks.'));
        print(c.gray('  Add .ai-manager/ to .gitignore: it holds local artifacts and events.'));
        return undefined;
      }
      if (sub === 'uninstall') {
        const r = hooks.uninstall(projectDir);
        return print(`${c.green('✔')} Removed ${r.removed} hook entries from ${r.file}`);
      }
      const st = hooks.status(projectDir);
      print(`Settings: ${st.file}`);
      print(`Installed: ${st.installed.length ? c.green(st.installed.join(', ')) : c.yellow('none')}`);
      if (st.installed.length && st.missing.length) print(`Missing: ${c.yellow(st.missing.join(', '))}`);
      print(`Events recorded: ${st.events}${st.last ? ` (last: ${st.last.hook_event_name}, ${new Date(st.last.ts).toLocaleString()})` : ''}`);
      return undefined;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run "aim help".`);
  }
}

main().catch((e) => {
  process.stderr.write(c.red('Error: ') + e.message + '\n');
  process.exit(1);
});
