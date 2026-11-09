'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseProvider } = require('./base');

/**
 * Cursor AI IDE Provider
 *
 * Transcripts at:
 *   ~/.cursor/projects/<encoded-project>/agent-transcripts/<session>/<session>.jsonl
 *   ~/.cursor/projects/<encoded-project>/agent-transcripts/<session>/subagents/<subagent>.jsonl
 */
class CursorProvider extends BaseProvider {
  constructor(opts = {}) {
    super('cursor', 'Cursor', opts);
    this.cursorDir = opts.cursorDir || path.join(os.homedir(), '.cursor');
    this.projectsDir = path.join(this.cursorDir, 'projects');
  }

  isAvailable(projectDir) {
    return fs.existsSync(this.projectsDir);
  }

  encodeProject(projectDir) {
    return path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-');
  }

  discover(projectDir, opts = {}) {
    const onlySession = opts.onlySession;
    const out = [];
    if (!fs.existsSync(this.projectsDir)) return out;

    const wantEncoded = projectDir ? this.encodeProject(projectDir).toLowerCase() : null;
    let projDirs = [];
    try { projDirs = fs.readdirSync(this.projectsDir); } catch { return out; }

    for (const p of projDirs) {
      if (wantEncoded && p.toLowerCase() !== wantEncoded) continue;
      const transBase = path.join(this.projectsDir, p, 'agent-transcripts');
      let sessions = [];
      try { sessions = fs.readdirSync(transBase); } catch { continue; }

      for (const sid of sessions) {
        if (onlySession && sid !== onlySession) continue;
        const sdir = path.join(transBase, sid);
        const mainFile = path.join(sdir, `${sid}.jsonl`);
        if (fs.existsSync(mainFile)) {
          out.push({
            file: mainFile,
            sessionId: sid,
            agentId: sid,
            kind: 'main',
            provider: this.name,
          });
        }

        const subagentsDir = path.join(sdir, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(subagentsDir); } catch { /* no subagents */ }
        for (const sub of subs) {
          if (!sub.endsWith('.jsonl')) continue;
          const subId = sub.slice(0, -6);
          out.push({
            file: path.join(subagentsDir, sub),
            sessionId: sid,
            agentId: subId,
            kind: 'subagent',
            provider: this.name,
          });
        }
      }
    }

    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  }

  parseLine(raw, fstate) {
    if (!raw || typeof raw !== 'object') return null;

    // 1. Role-based message: {"role":"user"|"assistant", "message":{...}}
    if (raw.role) {
      const msg = raw.message || {};
      const ts = raw.timestamp || new Date().toISOString();
      return {
        type: raw.role === 'user' ? 'user' : 'assistant',
        timestamp: ts,
        message: {
          role: raw.role,
          model: raw.model || 'Cursor',
          content: msg.content || (msg.text ? [{ type: 'text', text: msg.text }] : []),
          stop_reason: raw.role === 'assistant' ? 'end_turn' : null,
        },
      };
    }

    // 2. Turn ended: {"type":"turn_ended","status":"success"|"error","error":"..."}
    if (raw.type === 'turn_ended') {
      const isErr = raw.status === 'error';
      return {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        isApiErrorMessage: isErr,
        message: {
          role: 'assistant',
          content: isErr && raw.error ? [{ type: 'text', text: raw.error }] : [],
          stop_reason: 'end_turn',
        },
      };
    }

    // 3. Native tool / user format fallback
    return raw;
  }
}

module.exports = { CursorProvider };
