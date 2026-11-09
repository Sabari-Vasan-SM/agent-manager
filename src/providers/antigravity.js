'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseProvider } = require('./base');

/**
 * Antigravity Provider
 *
 * Reads transcripts from:
 *   ~/.gemini/antigravity/brain/<conv-id>/.system_generated/logs/transcript.jsonl
 *   ~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl
 *
 * Inspects .system_generated/subagents/ for spawned subagents.
 */
class AntigravityProvider extends BaseProvider {
  constructor(opts = {}) {
    super('antigravity', 'Antigravity', opts);
    this.brainDirs = opts.brainDirs || [
      path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    ];
  }

  isAvailable(projectDir) {
    for (const bdir of this.brainDirs) {
      if (fs.existsSync(bdir)) return true;
    }
    return false;
  }

  /**
   * Check if a conversation brain directory belongs to the given projectDir.
   */
  matchesProject(convDir, projectDir) {
    if (!projectDir) return true;
    const target = path.resolve(projectDir);

    // 1. Check subagents metadata or message logs for workspace path
    const subagentsDir = path.join(convDir, '.system_generated', 'subagents');
    try {
      const files = fs.readdirSync(subagentsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const data = JSON.parse(fs.readFileSync(path.join(subagentsDir, f), 'utf8'));
        if (data.workspaceUris) {
          for (const u of data.workspaceUris) {
            const clean = decodeURIComponent(u.replace(/^file:\/\//, ''));
            if (path.resolve(clean) === target) return true;
          }
        }
      }
    } catch { /* ignore */ }

    // 2. Read first few lines of transcript.jsonl to find workspace/cwd/USER_SETTINGS
    const tfile = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const fd = fs.openSync(tfile, 'r');
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      const sample = buf.toString('utf8', 0, bytesRead);
      if (sample.includes(target)) return true;
    } catch { /* ignore */ }

    return false;
  }

  discover(projectDir, opts = {}) {
    const onlySession = opts.onlySession;
    const out = [];

    for (const bdir of this.brainDirs) {
      let convs = [];
      try { convs = fs.readdirSync(bdir); } catch { continue; }

      for (const convId of convs) {
        if (onlySession && convId !== onlySession) continue;
        const convDir = path.join(bdir, convId);
        const tfile = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tfile)) continue;

        // Verify if session matches target project
        if (projectDir && !this.matchesProject(convDir, projectDir)) continue;

        out.push({
          file: tfile,
          sessionId: convId,
          agentId: convId,
          kind: 'main',
          provider: this.name,
          convDir,
        });

        // Discover subagents recorded in .system_generated/subagents/
        const subagentsDir = path.join(convDir, '.system_generated', 'subagents');
        try {
          const sfiles = fs.readdirSync(subagentsDir);
          for (const sf of sfiles) {
            if (!sf.endsWith('.json')) continue;
            const subId = sf.slice(0, -5);
            const subMeta = path.join(subagentsDir, sf);
            const subConvDir = path.join(bdir, subId);
            const subTfile = path.join(subConvDir, '.system_generated', 'logs', 'transcript.jsonl');
            out.push({
              file: fs.existsSync(subTfile) ? subTfile : tfile,
              sessionId: convId,
              agentId: subId,
              kind: 'subagent',
              meta: subMeta,
              provider: this.name,
              convDir: subConvDir,
            });
          }
        } catch { /* no subagents directory */ }
      }
    }

    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  }

  parseLine(raw, fstate) {
    if (!raw || typeof raw !== 'object') return null;

    // Antigravity format:
    // { step_index, source, type, status, created_at, content, thinking, tool_calls, input_tokens, output_tokens, cache_read_tokens }
    const ts = raw.created_at || (raw.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString());

    // 1. User Input
    if (raw.type === 'USER_INPUT' || raw.source === 'USER_EXPLICIT') {
      let text = raw.content || '';
      // Extract prompt text from tags if present
      const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
      if (reqMatch) text = reqMatch[1].trim();

      return {
        type: 'user',
        timestamp: ts,
        message: {
          role: 'user',
          content: text,
        },
      };
    }

    // 2. Assistant Response (Planner Response or Thinking/Content)
    if (raw.type === 'PLANNER_RESPONSE' || (raw.source === 'MODEL' && raw.tool_calls && raw.tool_calls.length)) {
      const toolCalls = [];
      for (let i = 0; i < (raw.tool_calls || []).length; i++) {
        const tc = raw.tool_calls[i];
        let args = tc.args || tc.arguments || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = { raw: args }; }
        }
        // Unescape stringified inner values if needed
        const cleaned = {};
        for (const [k, v] of Object.entries(args)) {
          if (typeof v === 'string' && (v.startsWith('"') && v.endsWith('"') || v.startsWith('{') && v.endsWith('}'))) {
            try { cleaned[k] = JSON.parse(v); } catch { cleaned[k] = v; }
          } else {
            cleaned[k] = v;
          }
        }

        toolCalls.push({
          type: 'tool_use',
          id: tc.id || `call_${raw.step_index || 0}_${i}`,
          name: tc.name,
          input: cleaned,
        });
      }

      const content = [];
      if (raw.content) content.push({ type: 'text', text: raw.content });
      content.push(...toolCalls);

      const usage = {
        input_tokens: raw.input_tokens || 0,
        output_tokens: raw.output_tokens || 0,
        cache_read_input_tokens: raw.cache_read_tokens || 0,
      };

      return {
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          model: raw.model || 'Antigravity',
          content,
          usage,
          stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
        },
      };
    }

    // 3. Tool results / Execution outputs (GENERIC type from MODEL or TOOL)
    if (raw.type === 'GENERIC' || raw.type === 'TOOL_RESULT' || raw.source === 'TOOL') {
      const isError = raw.status === 'ERROR' || /Command exited with code [1-9]/.test(raw.content || '');
      // If content mentions subagent creation:
      // "Created the following subagent:\n{\n  \"conversationId\": \"...\" ...}"
      const subMatch = /"conversationId":\s*"([^"]+)"/.exec(raw.content || '');
      const toolUseResult = subMatch ? { agentId: subMatch[1] } : {};

      return {
        type: 'user',
        timestamp: ts,
        toolUseResult,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: raw.tool_use_id || `call_${(raw.step_index || 1) - 1}_0`,
              content: raw.content || '',
              is_error: isError,
            },
          ],
        },
      };
    }

    return null;
  }
}

module.exports = { AntigravityProvider };
