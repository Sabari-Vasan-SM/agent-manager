'use strict';
/**
 * Claude Code hook integration.
 *
 * `aim hooks install` adds hook commands to <project>/.claude/settings.local.json.
 * Claude Code then runs `aim hook` on each event. The handler appends the event to
 * <project>/.ai-manager/hooks.jsonl and, when an agent stops, writes its artifacts at once.
 * Hooks are optional: the monitor also works from transcripts alone.
 */
const fs = require('fs');
const path = require('path');
const { storeDir, ensureDir, findProjectRoot } = require('./paths');

const MARK = '--aim-managed';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function settingsFile(projectDir) {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function hookCommand() {
  const script = path.resolve(__dirname, '..', 'bin', 'aim.js');
  return `node "${script}" hook ${MARK}`;
}

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${e.message}`);
  }
}

function isOurs(group) {
  return (group.hooks || []).some((h) => String(h.command || '').includes(MARK));
}

function install(projectDir) {
  const file = settingsFile(projectDir);
  const settings = readSettings(file);
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    const groups = (settings.hooks[ev] || []).filter((g) => !isOurs(g));
    const group = { hooks: [{ type: 'command', command: hookCommand(), timeout: 30 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    groups.push(group);
    settings.hooks[ev] = groups;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function uninstall(projectDir) {
  const file = settingsFile(projectDir);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readSettings(file);
  let removed = 0;
  for (const ev of Object.keys(settings.hooks || {})) {
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter((g) => !isOurs(g));
    removed += before - settings.hooks[ev].length;
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, removed };
}

function status(projectDir) {
  const file = settingsFile(projectDir);
  let settings = {};
  try { settings = readSettings(file); } catch { /* treat as not installed */ }
  const installed = EVENTS.filter((ev) => (settings.hooks && settings.hooks[ev] || []).some(isOurs));
  const log = path.join(storeDir(projectDir), 'hooks.jsonl');
  let events = 0;
  let last = null;
  try {
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    events = lines.length;
    if (lines.length) last = JSON.parse(lines[lines.length - 1]);
  } catch { /* no events yet */ }
  return { file, installed, missing: EVENTS.filter((e) => !installed.includes(e)), events, last };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000).unref();
  });
}

/** Entry point for `aim hook`. It never fails and never prints, so it cannot disturb Claude Code. */
async function handle() {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    const projectDir = findProjectRoot(input.cwd || process.cwd());
    const dir = ensureDir(storeDir(projectDir));
    const ev = {
      ts: Date.now(),
      hook_event_name: input.hook_event_name,
      session_id: input.session_id,
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      message: input.message,
    };
    fs.appendFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify(ev) + '\n');
    if (['Stop', 'SubagentStop', 'SessionEnd'].includes(input.hook_event_name) && input.session_id) {
      const { Monitor } = require('./monitor');
      const m = new Monitor({ projectDir, maxAgeHours: 0 });
      m.refresh(input.session_id);
    }
  } catch (e) {
    try { process.stderr.write(`aim hook: ${e.message}\n`); } catch { /* ignore */ }
  }
  process.exit(0);
}

module.exports = { install, uninstall, status, handle, EVENTS, settingsFile };
