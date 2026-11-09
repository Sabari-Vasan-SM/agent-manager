'use strict';
/**
 * Demo: writes realistic Claude Code transcripts over time into a temporary Claude config dir,
 * so the CLI and dashboard can be tried without a real agent run.
 * One main session plans work, starts 3 parallel subagents (one of them fails), then finishes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encodeProject } = require('./paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomUUID();
const tid = () => 'toolu_' + crypto.randomBytes(12).toString('hex');

function demoPaths(root = path.join(os.tmpdir(), 'aim-demo')) {
  const projectDir = path.join(root, 'shop-api');
  const claudeDir = path.join(root, 'claude');
  return { root, projectDir, claudeDir, transcriptDir: path.join(claudeDir, 'projects', encodeProject(projectDir)) };
}

class Writer {
  constructor(file, sessionId, agentId) {
    this.file = file; this.sessionId = sessionId; this.agentId = agentId;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  put(obj) {
    const line = { ...obj, uuid: uid(), timestamp: new Date().toISOString(), sessionId: this.sessionId, cwd: 'demo' };
    if (this.agentId) { line.isSidechain = true; line.agentId = this.agentId; }
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
  }
  prompt(text) { this.put({ type: 'user', message: { role: 'user', content: text } }); }
  tool(name, input, id = tid()) {
    this.put({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 900 + Math.round(Math.random() * 3000), output_tokens: 80 + Math.round(Math.random() * 400) } } });
    return id;
  }
  result(id, text, isError = false) {
    this.put({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  }
  say(text, end = true) {
    this.put({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: end ? 'end_turn' : null, usage: { input_tokens: 2000, output_tokens: 300 } } });
  }
  async call(name, input, text = 'ok', ms = 900, isError = false) {
    const id = this.tool(name, input);
    await sleep(ms);
    this.result(id, text, isError);
    await sleep(Math.min(250, ms / 4));
    return id;
  }
}

async function subagent(main, P, spawnId, agentId, type, description, steps, final, fail) {
  const w = new Writer(path.join(P.transcriptDir, main.sessionId, 'subagents', `agent-${agentId}.jsonl`), main.sessionId, agentId);
  fs.writeFileSync(path.join(P.transcriptDir, main.sessionId, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: type, description, toolUseId: spawnId, spawnDepth: 1 }));
  w.prompt(`${description}. Work in ${P.projectDir}.`);
  await sleep(600);
  for (const [name, input, text, ms, err] of steps) await w.call(name, input, text, ms, err);
  if (fail) {
    w.say(final, false);
    w.put({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }], stop_reason: 'stop_sequence' } });
    main.result(spawnId, 'Agent failed: API Error: 529 Overloaded', true);
  } else {
    w.say(final);
    main.result(spawnId, final);
  }
}

async function runCycle(P, n, speed = 1) {
  const f = (p) => path.join(P.projectDir, p);
  const sid = uid();
  const main = new Writer(path.join(P.transcriptDir, `${sid}.jsonl`), sid);
  main.put({ type: 'custom-title', customTitle: `Discount codes for checkout #${n}` });
  main.prompt('Add discount codes to checkout. Include tests, docs and a security review.');
  await sleep(800 * speed);
  const items = ['Read the checkout code', 'Implement the discount service', 'Write checkout tests', 'Review payment security', 'Wire discounts into checkout'];
  await main.call('mcp__ccd_turn__update_plan', { items: items.map((content, i) => ({ content, status: i ? 'pending' : 'in_progress' })) });
  await main.call('Read', { file_path: f('src/routes/checkout.js') }, 'export async function checkout(req, res) {...}', 1200 * speed);
  await main.call('Read', { file_path: f('src/models/order.js') }, 'class Order {...}', 900 * speed);
  await main.call('Grep', { pattern: 'applyPrice', path: f('src') }, 'src/services/pricing.js:14', 700 * speed);
  await main.call('mcp__ccd_turn__update_plan', { advance: true }, 'ok', 200);

  const s1 = main.tool('Agent', { description: 'Implement the discount service', subagent_type: 'general-purpose', prompt: 'Create src/services/discounts.js ...' });
  const s2 = main.tool('Agent', { description: 'Write checkout tests', subagent_type: 'general-purpose', prompt: 'Add tests for discount codes ...' });
  const s3 = main.tool('Agent', { description: 'Review payment security', subagent_type: 'Explore', prompt: 'Check the payment flow for abuse of discount codes ...' });
  const ms = (x) => x * speed;
  await Promise.all([
    subagent(main, P, s1, crypto.randomBytes(8).toString('hex'), 'general-purpose', 'Implement the discount service', [
      ['TodoWrite', { todos: [{ content: 'Design the DiscountCode model', status: 'in_progress' }, { content: 'Write the discount service', status: 'pending' }, { content: 'Add validation for expired codes', status: 'pending' }] }, 'ok', ms(500)],
      ['Read', { file_path: f('src/services/pricing.js') }, '...', ms(1500)],
      ['Write', { file_path: f('src/models/discount-code.js') }, 'File created', ms(2500)],
      ['TodoWrite', { todos: [{ content: 'Design the DiscountCode model', status: 'completed' }, { content: 'Write the discount service', status: 'in_progress' }, { content: 'Add validation for expired codes', status: 'pending' }] }, 'ok', ms(400)],
      ['Write', { file_path: f('src/services/discounts.js') }, 'File created', ms(3500)],
      ['Edit', { file_path: f('src/services/pricing.js'), old_string: 'a', new_string: 'b' }, 'File updated', ms(2000)],
      ['TodoWrite', { todos: [{ content: 'Design the DiscountCode model', status: 'completed' }, { content: 'Write the discount service', status: 'completed' }, { content: 'Add validation for expired codes', status: 'in_progress' }] }, 'ok', ms(400)],
      ['Edit', { file_path: f('src/services/discounts.js'), old_string: 'a', new_string: 'b' }, 'File updated', ms(2200)],
      ['Bash', { command: 'npm run lint', description: 'Lint the new service' }, 'No problems', ms(3000)],
      ['TodoWrite', { todos: [{ content: 'Design the DiscountCode model', status: 'completed' }, { content: 'Write the discount service', status: 'completed' }, { content: 'Add validation for expired codes', status: 'completed' }] }, 'ok', ms(300)],
    ], 'The discount service is done. `DiscountCode` model in src/models/discount-code.js, rules in src/services/discounts.js, and pricing.js now calls `applyDiscount`. Expired and over-used codes are rejected. Lint passes.'),
    subagent(main, P, s2, crypto.randomBytes(8).toString('hex'), 'general-purpose', 'Write checkout tests', [
      ['Read', { file_path: f('test/checkout.test.js') }, '...', ms(1800)],
      ['Glob', { pattern: 'test/**/*.test.js' }, '6 files', ms(800)],
      ['Write', { file_path: f('test/discounts.test.js') }, 'File created', ms(4000)],
      ['Bash', { command: 'npm test -- discounts', description: 'Run the discount tests' }, 'Exit code 1\n2 failing: expired code returns 500', ms(4000), true],
      ['Edit', { file_path: f('test/discounts.test.js'), old_string: 'a', new_string: 'b' }, 'File updated', ms(2500)],
      ['Bash', { command: 'npm test', description: 'Run the full test suite' }, '48 passing', ms(5000)],
    ], 'Added 12 tests in test/discounts.test.js. First run had 2 failures (expired code returned 500). Fixed the test setup; all 48 tests pass now.'),
    subagent(main, P, s3, crypto.randomBytes(8).toString('hex'), 'Explore', 'Review payment security', [
      ['Read', { file_path: f('src/routes/checkout.js') }, '...', ms(2000)],
      ['Grep', { pattern: 'discount', path: f('src') }, '9 matches', ms(1500)],
      ['Read', { file_path: f('src/middleware/auth.js') }, '...', ms(2500)],
      ['WebFetch', { url: 'https://owasp.org/www-project-top-ten/' }, 'Request failed with status 403', ms(2000), true],
    ], 'Partial review: the code does not limit how often one user can try a code.', true),
  ]);

  await main.call('mcp__ccd_turn__update_plan', { done: [2, 3, 4], start: 5 }, 'ok', 200);
  await main.call('Edit', { file_path: f('src/routes/checkout.js'), old_string: 'a', new_string: 'b' }, 'File updated', 2500 * speed);
  await main.call('Bash', { command: 'npm test', description: 'Run all tests' }, '48 passing', 3500 * speed);
  await main.call('mcp__ccd_turn__wrap_up', { recap: 'Discount codes work at checkout.' }, 'ok', 200);
  await sleep(300);
  main.say('Discount codes now work at checkout. The service, model and 12 tests are added, and all 48 tests pass. The security review subagent failed (API overload) before it finished; it found that code attempts are not rate limited. Run it again before release.');
  return sid;
}

/** Start the demo loop. Returns the paths; new cycles start every `everyMs`. */
function startDemo({ speed = 1, everyMs = 75000 } = {}) {
  const P = demoPaths();
  fs.rmSync(P.root, { recursive: true, force: true });
  fs.mkdirSync(P.projectDir, { recursive: true });
  fs.mkdirSync(P.transcriptDir, { recursive: true });
  let n = 0;
  const go = () => { n++; runCycle(P, n, speed).catch((e) => process.stderr.write(`demo: ${e.message}\n`)); };
  go();
  const timer = setInterval(go, everyMs);
  timer.unref();
  return P;
}

module.exports = { startDemo, demoPaths, runCycle };
