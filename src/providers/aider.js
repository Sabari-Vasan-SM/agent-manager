'use strict';

const fs = require('fs');
const path = require('path');
const { BaseProvider } = require('./base');

/**
 * Aider Provider
 *
 * Reads conversation history from <project>/.aider.chat.history.md
 */
class AiderProvider extends BaseProvider {
  constructor(opts = {}) {
    super('aider', 'Aider', opts);
  }

  isAvailable(projectDir) {
    if (!projectDir) return false;
    return fs.existsSync(path.join(projectDir, '.aider.chat.history.md'));
  }

  discover(projectDir, opts = {}) {
    if (!projectDir) return [];
    const historyFile = path.join(projectDir, '.aider.chat.history.md');
    if (!fs.existsSync(historyFile)) return [];

    return [
      {
        file: historyFile,
        sessionId: 'aider-session',
        agentId: 'aider-agent',
        kind: 'main',
        provider: this.name,
        isMarkdown: true,
      },
    ];
  }

  parseLine(raw, fstate) {
    if (typeof raw !== 'string') return null;
    const line = raw.trim();
    if (!line) return null;

    const ts = new Date().toISOString();

    // 1. Session start boundary: # aider chat started at 2026-11-09 14:00:00
    if (line.startsWith('# aider chat started at')) {
      const datePart = line.replace('# aider chat started at', '').trim();
      return {
        type: 'custom-title',
        timestamp: datePart ? new Date(datePart).toISOString() : ts,
        customTitle: `Aider (${datePart || 'session'})`,
      };
    }

    // 2. User prompt: #### prompt
    if (line.startsWith('#### ')) {
      return {
        type: 'user',
        timestamp: ts,
        message: {
          role: 'user',
          content: line.slice(5).trim(),
        },
      };
    }

    // 3. File edit action: Applied edit to path/to/file
    const editMatch = /^Applied edit to (.+)$/i.exec(line);
    if (editMatch) {
      const filePath = editMatch[1].trim();
      const toolId = `aider_edit_${Date.now()}`;
      return [
        {
          type: 'assistant',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'Aider',
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'Edit',
                input: { file_path: filePath },
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
                content: `Applied edit to ${filePath}`,
                is_error: false,
              },
            ],
          },
        },
      ];
    }

    // 4. Assistant response
    if (line.startsWith('> ') || (line.length > 5 && !line.startsWith('#'))) {
      const text = line.startsWith('> ') ? line.slice(2) : line;
      return {
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'Aider',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        },
      };
    }

    return null;
  }
}

module.exports = { AiderProvider };
