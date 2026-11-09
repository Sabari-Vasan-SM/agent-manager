'use strict';

const fs = require('fs');
const path = require('path');
const { BaseProvider } = require('./base');
const { claudeDir, transcriptDirs } = require('../paths');

class ClaudeCodeProvider extends BaseProvider {
  constructor(opts = {}) {
    super('claude-code', 'Claude Code', opts);
    this.claudeConfigDir = opts.claudeDir || claudeDir();
  }

  isAvailable(projectDir) {
    try {
      const dirs = transcriptDirs(projectDir, this.claudeConfigDir);
      return dirs.length > 0;
    } catch {
      return false;
    }
  }

  discover(projectDir, opts = {}) {
    const onlySession = opts.onlySession;
    const out = [];
    const dirs = transcriptDirs(projectDir, this.claudeConfigDir);

    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const sessionId = n.slice(0, -6);
        if (onlySession && sessionId !== onlySession) continue;
        out.push({
          file: path.join(dir, n),
          sessionId,
          agentId: sessionId,
          kind: 'main',
          provider: this.name,
        });

        const subDir = path.join(dir, sessionId, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(subDir); } catch { /* no subagents */ }
        for (const s of subs) {
          const m = /^agent-(.+)\.jsonl$/.exec(s);
          if (m) {
            out.push({
              file: path.join(subDir, s),
              sessionId,
              agentId: m[1],
              kind: 'subagent',
              meta: path.join(subDir, `agent-${m[1]}.meta.json`),
              provider: this.name,
            });
          }
        }
      }
    }

    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  }

  parseLine(raw, fstate) {
    // Claude transcript lines match the native format directly
    return raw;
  }
}

module.exports = { ClaudeCodeProvider };
