'use strict';
/** Terminal output: colors, tables and the views for `aim status`, `aim watch` and friends. */
const { fmtDuration } = require('./artifacts');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
  blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
};
const STATUS = {
  running: (s) => c.green(`● ${s}`), idle: (s) => c.yellow(`◐ ${s}`), completed: (s) => c.blue(`✔ ${s}`),
  failed: (s) => c.red(`✖ ${s}`), pending: (s) => c.gray(`○ ${s}`), in_progress: (s) => c.green(`▶ ${s}`),
};
const status = (s) => (STATUS[s] || ((x) => x))(s.replace('_', ' '));

// eslint-disable-next-line no-control-regex
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => [...visible(s)].length;
function pad(s, n) { const w = width(s); return w >= n ? s : s + ' '.repeat(n - w); }
function trunc(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s;
}

function ago(ts, now = Date.now()) {
  if (!ts) return '-';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] || ''))));
  const line = (r) => r.map((x, i) => pad(x || '', w[i])).join('  ').trimEnd();
  return [c.bold(line(headers)), c.gray(w.map((n) => '─'.repeat(n)).join('  ')), ...rows.map(line)].join('\n');
}

function bar(done, total, n = 12) {
  if (!total) return c.gray('·'.repeat(n));
  const f = Math.round((done / total) * n);
  return c.green('█'.repeat(f)) + c.gray('░'.repeat(n - f));
}

function cols() { return process.stdout.columns || 120; }

function summaryLine(s) {
  const m = s.summary;
  return [
    c.bold(`${m.total} agents`) + c.gray(` (${m.main} sessions, ${m.subagents} subagents)`),
    c.green(`${m.running} running`), c.yellow(`${m.idle} idle`), c.blue(`${m.completed} completed`), c.red(`${m.failed} failed`),
    `tasks ${m.tasks.completed}/${m.tasks.pending + m.tasks.in_progress + m.tasks.completed + m.tasks.failed}`,
    `${m.modifiedFiles} files changed`, `${m.artifacts} artifacts`,
  ].join(c.gray('  │  '));
}

/** Agents as a tree: sessions with their subagents under them. */
function agentTree(s, { all = false } = {}) {
  const ids = new Set(s.agents.map((a) => a.id));
  const kids = {};
  for (const a of s.agents) if (a.parentId && ids.has(a.parentId)) (kids[a.parentId] = kids[a.parentId] || []).push(a);
  let roots = s.agents.filter((a) => !a.parentId || !ids.has(a.parentId));
  const ended = (a) => a.status === 'completed' || a.status === 'failed';
  const flat = (a) => [a, ...(kids[a.id] || []).flatMap(flat)];
  if (!all) roots = roots.filter((r) => flat(r).some((a) => !ended(a)));
  const W = Math.max(20, Math.min(46, cols() - 90));
  const rows = [];
  const walk = (a, depth, last) => {
    const prefix = depth ? c.gray('  '.repeat(depth - 1) + (last ? '└─ ' : '├─ ')) : '';
    const p = a.progress.total ? `${bar(a.progress.done, a.progress.total, 8)} ${a.progress.done}/${a.progress.total}` : '';
    rows.push([
      prefix + trunc(a.name, W - depth * 2),
      a.kind === 'main' ? c.gray('session') : c.magenta(trunc(a.agentType, 16)),
      status(a.status),
      trunc(a.activity, Math.max(20, cols() - W - 70)),
      p,
      String(a.files.length),
      ago(a.lastActivity),
    ]);
    const k = kids[a.id] || [];
    k.forEach((x, i) => walk(x, depth + 1, i === k.length - 1));
  };
  roots.forEach((r) => walk(r, 0, true));
  if (!rows.length) return c.gray(all ? 'No agents found for this project.' : 'No active agents. Use --all to show ended sessions.');
  return table(['AGENT', 'TYPE', 'STATUS', 'CURRENT TASK', 'PROGRESS', 'FILES', 'LAST'], rows);
}

function tasksView(s, { all = false } = {}) {
  const byId = Object.fromEntries(s.agents.map((a) => [a.id, a]));
  const ended = (a) => a && (a.status === 'completed' || a.status === 'failed');
  const tasks = s.tasks.filter((t) => all || !ended(byId[t.agentId]) || t.status !== 'completed');
  if (!tasks.length) return c.gray('No tasks found.');
  const order = { in_progress: 0, pending: 1, failed: 2, completed: 3 };
  tasks.sort((a, b) => order[a.status] - order[b.status]);
  return table(['STATUS', 'TASK', 'OWNER', 'KIND'], tasks.map((t) => [
    status(t.status), trunc(t.title, Math.max(30, cols() - 70)), trunc(byId[t.agentId] ? byId[t.agentId].name : '?', 36), t.source,
  ]));
}

function filesView(s) {
  if (!s.files.length) return c.gray('No files touched yet.');
  return table(['FILE', 'R', 'E', 'W', 'AGENTS', 'LAST'], s.files.slice(0, 60).map((f) => [
    (f.edit || f.write ? c.yellow('✎ ') : '  ') + trunc(f.path, Math.max(30, cols() - 70)),
    String(f.read), String(f.edit), String(f.write),
    trunc(f.agents.map((a) => a.name).join(', '), 36), ago(f.lastTs),
  ]));
}

function artifactsView(list, limit = 25) {
  if (!list.length) return c.gray('No artifacts yet. They appear when an agent finishes a task.');
  return table(['ID', 'STATUS', 'AGENT', 'TASK', 'FILES', 'ISSUES', 'TIME', 'ENDED'], list.slice(0, limit).map((a) => [
    c.cyan(a.id), status(a.status), trunc(a.agentName, 28), trunc(a.prompt, Math.max(24, cols() - 110)),
    String(a.filesModified), a.issues ? c.red(String(a.issues)) : '0', fmtDuration(a.durationMs), ago(a.endedAt),
  ]));
}

function activityView(s, limit = 15) {
  return s.activity.slice(0, limit).map((e) => {
    const t = new Date(e.ts).toLocaleTimeString();
    return `${c.gray(t)}  ${pad(c.bold(trunc(e.agentName, 28)), 28)}  ${e.error ? c.red(e.text) : e.text}`;
  }).join('\n') || c.gray('No activity yet.');
}

function dashboardText(s, opts = {}) {
  const head = `${c.bold(c.cyan('AI Manager'))} ${c.gray('·')} ${c.bold(s.project.name)} ${c.gray(s.project.dir)}  ${c.gray(new Date(s.generatedAt).toLocaleTimeString())}`;
  return [head, summaryLine(s), '', agentTree(s, opts), '', c.bold('Recent activity'), activityView(s, opts.activity || 8)].join('\n');
}

module.exports = { c, status, table, agentTree, tasksView, filesView, artifactsView, activityView, dashboardText, summaryLine, trunc };
