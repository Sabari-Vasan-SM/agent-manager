'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseProvider } = require('./base');

/**
 * Windsurf (Cascade) Provider
 *
 * Reads transcripts from ~/.windsurf/transcripts/{trajectory_id}.jsonl
 */
class WindsurfProvider extends BaseProvider {
  constructor(opts = {}) {
    super('windsurf', 'Windsurf', opts);
    this.windsurfDir = opts.windsurfDir || path.join(os.homedir(), '.windsurf');
    this.transcriptsDir = path.join(this.windsurfDir, 'transcripts');
  }

  isAvailable(projectDir) {
    return fs.existsSync(this.transcriptsDir);
  }

  matchesProject(filePath, projectDir) {
    if (!projectDir) return true;
    const target = path.resolve(projectDir);
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      return buf.toString('utf8', 0, read).includes(target);
    } catch { return false; }
  }

  discover(projectDir, opts = {}) {
    const onlySession = opts.onlySession;
    const out = [];
    if (!fs.existsSync(this.transcriptsDir)) return out;

    let files = [];
    try { files = fs.readdirSync(this.transcriptsDir); } catch { return out; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const trajectoryId = f.slice(0, -6);
      if (onlySession && trajectoryId !== onlySession) continue;
      const fullPath = path.join(this.transcriptsDir, f);

      if (projectDir && !this.matchesProject(fullPath, projectDir)) continue;

      out.push({
        file: fullPath,
        sessionId: trajectoryId,
        agentId: trajectoryId,
        kind: 'main',
        provider: this.name,
      });
    }

    return out;
  }

  parseLine(raw, fstate) {
    if (!raw || typeof raw !== 'object') return null;

    const ts = raw.timestamp || new Date().toISOString();

    // 1. User input
    if (raw.type === 'user_input' && raw.user_input) {
      const text = raw.user_input.user_response || raw.user_input.text || '';
      return {
        type: 'user',
        timestamp: ts,
        message: {
          role: 'user',
          content: text,
        },
      };
    }

    // 2. Planner / assistant response
    if (raw.type === 'planner_response' && raw.planner_response) {
      const text = raw.planner_response.response || '';
      return {
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'Cascade',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        },
      };
    }

    // 3. Code action (editing / writing a file)
    if (raw.type === 'code_action' && raw.code_action) {
      const ca = raw.code_action;
      const toolId = `action_${Date.now()}`;
      return [
        {
          type: 'assistant',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'Cascade',
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'code_action',
                input: { path: ca.path || ca.file_path, new_content: ca.new_content },
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
                content: raw.status === 'done' ? 'File updated' : 'Error updating file',
                is_error: raw.status !== 'done',
              },
            ],
          },
        },
      ];
    }

    // 4. Command action (running shell commands)
    if (raw.type === 'command_action' && raw.command_action) {
      const cmd = raw.command_action.command;
      const toolId = `cmd_${Date.now()}`;
      return [
        {
          type: 'assistant',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'Cascade',
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'command_action',
                input: { command: cmd },
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
                content: raw.status === 'done' ? 'Command completed' : 'Command failed',
                is_error: raw.status !== 'done',
              },
            ],
          },
        },
      ];
    }

    return null;
  }
}

module.exports = { WindsurfProvider };
