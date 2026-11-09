'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseProvider } = require('./base');

/**
 * OpenAI Codex CLI Provider
 *
 * Reads transcripts from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
class CodexProvider extends BaseProvider {
  constructor(opts = {}) {
    super('codex', 'Codex CLI', opts);
    this.codexDir = opts.codexDir || path.join(os.homedir(), '.codex');
    this.sessionsDir = path.join(this.codexDir, 'sessions');
  }

  isAvailable(projectDir) {
    return fs.existsSync(this.sessionsDir);
  }

  /**
   * Fast check if a Codex rollout file belongs to projectDir.
   */
  matchesProject(filePath, projectDir) {
    if (!projectDir) return true;
    const target = path.resolve(projectDir);
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16384);
      const read = fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const chunk = buf.toString('utf8', 0, read);
      if (chunk.includes(target)) return true;
    } catch { /* ignore */ }
    return false;
  }

  discover(projectDir, opts = {}) {
    const onlySession = opts.onlySession;
    const out = [];
    if (!fs.existsSync(this.sessionsDir)) return out;

    // Walk YYYY/MM/DD
    const years = this.safeReaddir(this.sessionsDir);
    for (const y of years) {
      const ydir = path.join(this.sessionsDir, y);
      const months = this.safeReaddir(ydir);
      for (const m of months) {
        const mdir = path.join(ydir, m);
        const days = this.safeReaddir(mdir);
        for (const d of days) {
          const ddir = path.join(mdir, d);
          const files = this.safeReaddir(ddir);
          for (const f of files) {
            if (!f.endsWith('.jsonl') || !f.startsWith('rollout-')) continue;
            const fullPath = path.join(ddir, f);

            // Parse session IDs from filename
            // Format: rollout-YYYY-MM-DDThh-mm-ss-<main-id>[_<sub-id>].jsonl
            const m = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([a-f0-9-]+)(?:_([a-f0-9-]+))?\.jsonl$/i.exec(f);
            if (!m) continue;
            const mainId = m[1];
            const subId = m[2];
            const isSub = Boolean(subId);
            const sessionId = mainId;
            const agentId = isSub ? subId : mainId;

            if (onlySession && sessionId !== onlySession) continue;
            if (projectDir && !this.matchesProject(fullPath, projectDir)) continue;

            out.push({
              file: fullPath,
              sessionId,
              agentId,
              kind: isSub ? 'subagent' : 'main',
              provider: this.name,
            });
          }
        }
      }
    }

    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  }

  safeReaddir(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
  }

  parseLine(raw, fstate) {
    if (!raw || typeof raw !== 'object') return null;

    const ts = raw.timestamp || new Date().toISOString();
    const payload = raw.payload || {};

    // 1. Session Meta
    if (raw.type === 'session_meta') {
      const cwd = payload.cwd || '';
      const title = cwd ? path.basename(cwd) : `Codex ${payload.session_id ? payload.session_id.slice(0, 8) : ''}`;
      return [
        {
          type: 'custom-title',
          timestamp: ts,
          customTitle: title,
        },
      ];
    }

    // 2. Completed items (UserMessage, AgentMessage, McpToolCall, etc.)
    if (payload.type === 'item_completed' && payload.item) {
      const item = payload.item;

      if (item.type === 'UserMessage') {
        const textParts = (item.content || [])
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text);
        const text = textParts.join('\n').trim();
        return {
          type: 'user',
          timestamp: ts,
          message: {
            role: 'user',
            content: text,
          },
        };
      }

      if (item.type === 'AgentMessage') {
        const textParts = (item.content || [])
          .filter((c) => c && (c.type === 'text' || c.type === 'output_text'))
          .map((c) => c.text);
        return {
          type: 'assistant',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: payload.model || 'Codex',
            content: [{ type: 'text', text: textParts.join('\n') }],
            stop_reason: 'end_turn',
          },
        };
      }

      if (item.type === 'McpToolCall' || item.type === 'ToolCall') {
        const toolName = item.tool || item.name || 'tool';
        const toolId = item.id || `call_${Date.now()}`;
        const args = item.arguments || item.input || {};
        const isError = Boolean(item.status === 'failed' || (item.result && item.result.isError));
        const resultContent = item.result
          ? (Array.isArray(item.result.content)
            ? item.result.content.map((c) => c.text || '').join('\n')
            : String(item.result))
          : 'ok';

        // Emit assistant tool_use followed by user tool_result
        return [
          {
            type: 'assistant',
            timestamp: ts,
            message: {
              role: 'assistant',
              model: 'Codex',
              content: [
                {
                  type: 'tool_use',
                  id: toolId,
                  name: toolName,
                  input: args,
                },
              ],
              stop_reason: 'tool_use',
            },
          },
          {
            type: 'user',
            timestamp: ts,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: resultContent,
                  is_error: isError,
                },
              ],
            },
          },
        ];
      }
    }

    // 3. Task complete / stop
    if (payload.type === 'task_complete') {
      return {
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
        },
      };
    }

    return null;
  }
}

module.exports = { CodexProvider };
