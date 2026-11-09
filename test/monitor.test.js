'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { Monitor } = require('../src/monitor');
const { demoPaths, runCycle } = require('../src/demo');
const hooks = require('../src/hooks');
const { createServer } = require('../src/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aim-test-'));

async function demoRun() {
  const P = demoPaths(tmp());
  fs.mkdirSync(P.projectDir, { recursive: true });
  await runCycle(P, 1, 0.01);
  return P;
}

test('a demo run gives one session with 3 subagents, tasks, files and artifacts', async () => {
  const P = await demoRun();
  const m = new Monitor({ projectDir: P.projectDir, claudeDir: P.claudeDir, maxAgeHours: 0 });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.summary.main, 1);
  assert.strictEqual(s.summary.subagents, 3);

  const main = s.agents.find((a) => a.kind === 'main');
  assert.strictEqual(main.name, 'Discount codes for checkout #1');
  assert.strictEqual(main.status, 'idle'); // turn ended, waiting for the user
  assert.deepStrictEqual(main.progress, { done: 5, total: 5 });

  const byName = Object.fromEntries(s.agents.map((a) => [a.name, a]));
  assert.strictEqual(byName['Implement the discount service'].status, 'completed');
  assert.strictEqual(byName['Implement the discount service'].parentId, main.id);
  assert.deepStrictEqual(byName['Implement the discount service'].progress, { done: 3, total: 3 });
  assert.strictEqual(byName['Review payment security'].status, 'failed');
  assert.strictEqual(byName['Write checkout tests'].errors.length, 1);

  const svc = s.files.find((f) => f.path === 'src/services/discounts.js');
  assert.ok(svc && svc.write === 1 && svc.edit === 1, 'tracks writes and edits with project-relative paths');

  assert.strictEqual(s.artifacts.length, 4);
  const art = m.artifacts.get(s.artifacts.find((a) => a.agentName === 'Implement the discount service').id);
  assert.strictEqual(art.status, 'completed');
  assert.deepStrictEqual(art.filesModified.map((f) => f.path).sort(), ['src/models/discount-code.js', 'src/services/discounts.js', 'src/services/pricing.js']);
  assert.match(art.markdown, /## Modified files/);
  assert.match(art.summary, /discount service is done/);
});

test('reading is incremental and a running agent shows its current tool', async () => {
  const P = await demoRun();
  const m = new Monitor({ projectDir: P.projectDir, claudeDir: P.claudeDir, maxAgeHours: 0 });
  m.refresh();
  const file = path.join(P.transcriptDir, `${m.snapshot().agents.find((a) => a.kind === 'main').id}.jsonl`);
  assert.strictEqual(m.refresh(), false, 'no change without new lines');
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ ...o, timestamp: new Date().toISOString() }) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'Now add a changelog entry' } });
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: path.join(P.projectDir, 'CHANGELOG.md') } }], stop_reason: 'tool_use' } });
  assert.strictEqual(m.refresh(), true);
  const main = m.snapshot().agents.find((a) => a.kind === 'main');
  assert.strictEqual(main.status, 'running');
  assert.strictEqual(main.activity, 'Editing CHANGELOG.md');
  assert.strictEqual(main.turns, 2);
});

test('an interrupted turn is a failed artifact', async () => {
  const P = await demoRun();
  const m = new Monitor({ projectDir: P.projectDir, claudeDir: P.claudeDir, maxAgeHours: 0 });
  m.refresh();
  const id = m.snapshot().agents.find((a) => a.kind === 'main').id;
  const file = path.join(P.transcriptDir, `${id}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ ...o, timestamp: new Date().toISOString() }) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'Deploy it' } });
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.agents.find((a) => a.id === id).status, 'failed');
  const art = s.artifacts.find((a) => a.agentId === id && a.turn === 2);
  assert.strictEqual(art.status, 'failed');
});

test('hooks install, record events, and uninstall without touching other hooks', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  const settings = path.join(dir, '.claude', 'settings.local.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' }));
  hooks.install(dir);
  hooks.install(dir); // idempotent
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, '*');

  const bin = path.join(__dirname, '..', 'bin', 'aim.js');
  const r = spawnSync(process.execPath, [bin, 'hook'], {
    input: JSON.stringify({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude needs your permission to use Bash', cwd: dir }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.toString(), '', 'the hook prints nothing');
  assert.strictEqual(hooks.status(dir).events, 1);

  const u = hooks.uninstall(dir);
  assert.strictEqual(u.removed, hooks.EVENTS.length);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepStrictEqual(after.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  assert.strictEqual(after.model, 'x');
});

test('the server requires the token when one is set', async () => {
  const P = await demoRun();
  const m = new Monitor({ projectDir: P.projectDir, claudeDir: P.claudeDir, maxAgeHours: 0 });
  const server = createServer(m, { token: 'secret123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p) => new Promise((resolve) => http.get(`http://127.0.0.1:${port}${p}`, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
  }));
  try {
    assert.strictEqual((await get('/api/state')).code, 401);
    const ok = await get('/api/state?token=secret123');
    assert.strictEqual(ok.code, 200);
    const state = JSON.parse(ok.body);
    assert.strictEqual(state.summary.subagents, 3);
    const art = await get(`/api/artifacts/${state.artifacts[0].id}.md?token=secret123`);
    assert.strictEqual(art.code, 200);
    assert.strictEqual((await get('/api/artifacts/..%2F..%2Fx?token=secret123')).code, 404);
  } finally {
    server.close();
  }
});
