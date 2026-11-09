'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Monitor } = require('../src/monitor');
const { AntigravityProvider } = require('../src/providers/antigravity');
const { CodexProvider } = require('../src/providers/codex');
const { CursorProvider } = require('../src/providers/cursor');
const { WindsurfProvider } = require('../src/providers/windsurf');
const { AiderProvider } = require('../src/providers/aider');
const { resolveProviders } = require('../src/providers/registry');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aim-prov-test-'));

test('AntigravityProvider discovers and parses Antigravity transcripts', () => {
  const root = tmp();
  const projectDir = path.join(root, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const brainDir = path.join(root, 'gemini', 'antigravity', 'brain');
  const convId = 'conv-1234-abcd';
  const subId = 'sub-5678-ef01';
  const convDir = path.join(brainDir, convId);
  const logDir = path.join(convDir, '.system_generated', 'logs');
  const subagentsDir = path.join(convDir, '.system_generated', 'subagents');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(subagentsDir, { recursive: true });

  // Subagent metadata
  fs.writeFileSync(
    path.join(subagentsDir, `${subId}.json`),
    JSON.stringify({
      conversationId: subId,
      subagentDescriptor: { typeName: 'researcher', role: 'Security Auditor' },
      workspaceUris: [`file://${projectDir}`],
    })
  );

  // Transcript lines
  const lines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nAudit authentication and fix vulnerabilities\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [
        {
          name: 'read_file',
          args: { Path: path.join(projectDir, 'src/auth.js') },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'File content of auth.js',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [
        {
          name: 'write_file',
          args: { Path: path.join(projectDir, 'src/auth.js'), Content: 'fixed' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'Created file.',
    }),
  ];
  fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), lines.join('\n') + '\n');

  const provider = new AntigravityProvider({ brainDirs: [brainDir] });
  const discovered = provider.discover(projectDir);
  assert.strictEqual(discovered.length, 2);
  assert.strictEqual(discovered[0].sessionId, convId);
  assert.strictEqual(discovered[0].kind, 'main');
  assert.strictEqual(discovered[1].agentId, subId);
  assert.strictEqual(discovered[1].kind, 'subagent');

  // Monitor with Antigravity provider
  const m = new Monitor({
    projectDir,
    providers: [provider],
    maxAgeHours: 0,
  });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.summary.main, 1);
  const main = s.agents.find((a) => a.kind === 'main');
  assert.strictEqual(main.provider, 'antigravity');
  assert.strictEqual(main.providerName, 'Antigravity');
  assert.strictEqual(main.prompt, 'Audit authentication and fix vulnerabilities');
  assert.ok(s.files.some((f) => f.path === 'src/auth.js' && f.write >= 1));
});

test('CodexProvider discovers and parses Codex rollout transcripts', () => {
  const root = tmp();
  const projectDir = path.join(root, 'codex-repo');
  fs.mkdirSync(projectDir, { recursive: true });

  const codexDir = path.join(root, 'codex');
  const ddir = path.join(codexDir, 'sessions', '2026', '11', '09');
  fs.mkdirSync(ddir, { recursive: true });

  const sessionId = '01a0e8cb-6643-7622-8a96-dbcaff353e0f';
  const rolloutFile = path.join(ddir, `rollout-2026-11-09T12-00-00-${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: new Date().toISOString(),
      payload: {
        session_id: sessionId,
        cwd: projectDir,
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: 'Refactor database queries' }],
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'item_completed',
        item: {
          type: 'McpToolCall',
          id: 'call_db_patch',
          tool: 'apply_patch',
          arguments: { path: path.join(projectDir, 'src/db.js') },
          status: 'completed',
          result: 'Patched successfully',
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'item_completed',
        item: {
          type: 'AgentMessage',
          content: [{ type: 'text', text: 'Database queries have been refactored.' }],
        },
      },
    }),
  ];
  fs.writeFileSync(rolloutFile, lines.join('\n') + '\n');

  const provider = new CodexProvider({ codexDir });
  const discovered = provider.discover(projectDir);
  assert.strictEqual(discovered.length, 1);
  assert.strictEqual(discovered[0].sessionId, sessionId);

  const m = new Monitor({
    projectDir,
    providers: [provider],
    maxAgeHours: 0,
  });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.summary.main, 1);
  const agent = s.agents[0];
  assert.strictEqual(agent.provider, 'codex');
  assert.strictEqual(agent.providerName, 'Codex CLI');
  assert.strictEqual(agent.prompt, 'Refactor database queries');
  assert.ok(s.files.some((f) => f.path === 'src/db.js' && f.edit >= 1));
});

test('WindsurfProvider discovers and parses Cascade transcripts', () => {
  const root = tmp();
  const projectDir = path.join(root, 'windsurf-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const windsurfDir = path.join(root, 'windsurf');
  const tdir = path.join(windsurfDir, 'transcripts');
  fs.mkdirSync(tdir, { recursive: true });

  const trajectoryId = 'traj-999-xyz';
  const tfile = path.join(tdir, `${trajectoryId}.jsonl`);

  const lines = [
    JSON.stringify({
      type: 'user_input',
      timestamp: new Date().toISOString(),
      user_input: {
        user_response: 'Add payment gateway integration',
      },
    }),
    JSON.stringify({
      type: 'code_action',
      status: 'done',
      timestamp: new Date().toISOString(),
      code_action: {
        path: path.join(projectDir, 'src/payment.js'),
        new_content: 'export function pay() {}',
      },
    }),
    JSON.stringify({
      type: 'command_action',
      status: 'done',
      timestamp: new Date().toISOString(),
      command_action: {
        command: 'npm test -- payment',
      },
    }),
    JSON.stringify({
      type: 'planner_response',
      timestamp: new Date().toISOString(),
      planner_response: {
        response: 'Payment integration is complete and tests pass.',
      },
    }),
  ];
  fs.writeFileSync(tfile, lines.join('\n') + '\n');

  const provider = new WindsurfProvider({ windsurfDir });
  const discovered = provider.discover(projectDir);
  assert.strictEqual(discovered.length, 1);
  assert.strictEqual(discovered[0].sessionId, trajectoryId);

  const m = new Monitor({
    projectDir,
    providers: [provider],
    maxAgeHours: 0,
  });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.summary.main, 1);
  const agent = s.agents[0];
  assert.strictEqual(agent.provider, 'windsurf');
  assert.strictEqual(agent.providerName, 'Windsurf');
  assert.ok(s.files.some((f) => f.path === 'src/payment.js' && f.write >= 1));
});

test('AiderProvider parses markdown conversation history and file edits', () => {
  const root = tmp();
  const projectDir = path.join(root, 'aider-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const historyFile = path.join(projectDir, '.aider.chat.history.md');
  const md = [
    '# aider chat started at 2026-11-09 10:00:00',
    '',
    '#### Fix syntax error in utils.py',
    '',
    '> Looking at utils.py...',
    '',
    'Applied edit to src/utils.py',
    '',
    '> Fixed the syntax error on line 42.',
  ].join('\n');
  fs.writeFileSync(historyFile, md);

  const provider = new AiderProvider();
  const discovered = provider.discover(projectDir);
  assert.strictEqual(discovered.length, 1);

  const m = new Monitor({
    projectDir,
    providers: [provider],
    maxAgeHours: 0,
  });
  m.refresh();
  const s = m.snapshot();
  assert.strictEqual(s.summary.main, 1);
  const agent = s.agents[0];
  assert.strictEqual(agent.provider, 'aider');
  assert.strictEqual(agent.prompt, 'Fix syntax error in utils.py');
  assert.ok(s.files.some((f) => f.path === 'src/utils.py' && f.edit >= 1));
});

test('Multi-provider Monitor monitors multiple AI tools on the same project simultaneously', () => {
  const root = tmp();
  const projectDir = path.join(root, 'multi-ai-repo');
  fs.mkdirSync(projectDir, { recursive: true });

  // 1. Antigravity session
  const brainDir = path.join(root, 'gemini', 'antigravity', 'brain');
  const convId = 'agy-session-1';
  const agyLogDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(agyLogDir, { recursive: true });
  fs.writeFileSync(
    path.join(agyLogDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: `<USER_REQUEST>Build backend in ${projectDir}</USER_REQUEST>`,
        created_at: new Date().toISOString(),
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_file', args: { Path: path.join(projectDir, 'server.js') } }],
        created_at: new Date().toISOString(),
      }),
    ].join('\n') + '\n'
  );

  // 2. Aider session
  fs.writeFileSync(
    path.join(projectDir, '.aider.chat.history.md'),
    '# aider chat started at 2026-11-09 11:00:00\n\n#### Build frontend\n\nApplied edit to client.js\n'
  );

  const m = new Monitor({
    projectDir,
    providers: [
      new AntigravityProvider({ brainDirs: [brainDir] }),
      new AiderProvider(),
    ],
    maxAgeHours: 0,
  });
  m.refresh();
  const s = m.snapshot();

  assert.strictEqual(s.summary.main, 2);
  assert.strictEqual(s.summary.providers, 2);
  const provNames = s.agents.map((a) => a.provider).sort();
  assert.deepStrictEqual(provNames, ['aider', 'antigravity']);
  assert.strictEqual(s.files.length, 2);
});
