'use strict';
/**
 * Monitor: reads Claude Code transcripts for one project and builds a live model
 * of every agent (main sessions and subagents), their turns, tasks, files and errors.
 *
 * Sources, in order of trust:
 *   1. Transcripts  ~/.claude/projects/<encoded>/<session>.jsonl
 *                   ~/.claude/projects/<encoded>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)
 *   2. Hook events  <project>/.ai-manager/hooks.jsonl (optional, written by `aim hook`)
 *
 * Reading is incremental: each file keeps a byte offset, so refresh() is cheap.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, transcriptDirs, storeDir } = require('./paths');
const { ArtifactStore } = require('./artifacts');

const STALE_TOOL_MS = 10 * 60e3;   // a tool call with no result for this long = stalled
const STALE_THINK_MS = 3 * 60e3;   // no new line while the model "thinks" for this long = stalled
const SESSION_END_MS = 30 * 60e3;  // an idle main session with no activity for this long = completed
const RECENT_LIMIT = 40;

const FILE_TOOLS = {
  Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
};
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

function newAgent(id, kind, sessionId) {
  return {
    id, kind, sessionId,
    parentId: kind === 'main' ? null : sessionId,
    spawnToolUseId: null,
    name: '', agentType: kind === 'main' ? 'main' : 'subagent', description: '',
    model: null, startedAt: null, lastTs: null,
    turns: [], pending: new Map(), tasks: [], taskSeq: 0,
    tokens: { input: 0, output: 0 }, recent: [],
    transcript: null,
  };
}

function newTurn(index, prompt, ts, source) {
  return {
    index, prompt, source, startedAt: ts, endedAt: null, status: 'in_progress',
    files: {}, tools: {}, errors: [], finalText: '', subagents: [], tasks: null,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Describe a tool call as a short human activity line. */
function describeTool(name, input = {}, rel = (p) => p) {
  const f = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case 'Read': return `Reading ${rel(f)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Editing ${rel(f)}`;
    case 'Write': return `Writing ${rel(f)}`;
    case 'Bash': case 'PowerShell': return `Running: ${clip(input.description || input.command, 70)}`;
    case 'Grep': return `Searching for "${clip(input.pattern, 40)}"`;
    case 'Glob': return `Finding files ${clip(input.pattern, 40)}`;
    case 'Agent': case 'Task': return `Delegating: ${clip(input.description, 60)}`;
    case 'WebFetch': return `Fetching ${clip(input.url, 60)}`;
    case 'WebSearch': return `Searching the web: ${clip(input.query, 50)}`;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'mcp__ccd_turn__update_plan': return 'Updating the task list';
    default: return `Using ${name.replace(/^mcp__.+?__/, '')}`;
  }
}

function normStatus(s) {
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'active') return 'in_progress';
  if (s === 'failed' || s === 'cancelled' || s === 'deleted') return 'failed';
  return 'pending';
}

class Monitor {
  /**
   * @param {object} opts
   * @param {string} opts.projectDir   project root
   * @param {string} [opts.claudeDir]  Claude config dir (default ~/.claude)
   * @param {string} [opts.storeDir]   where artifacts and hook events live (default <project>/.ai-manager)
   * @param {number} [opts.maxAgeHours] hide agents with no activity for longer than this (0 = all)
   * @param {boolean} [opts.artifacts] write artifacts for finished turns (default true)
   */
  constructor(opts) {
    this.projectDir = path.resolve(opts.projectDir);
    this.claudeDir = opts.claudeDir || claudeDir();
    this.storeDir = opts.storeDir || storeDir(this.projectDir);
    this.maxAgeHours = opts.maxAgeHours == null ? 48 : opts.maxAgeHours;
    this.writeArtifacts = opts.artifacts !== false;
    this.now = opts.now || (() => Date.now());
    this.files = new Map();   // path -> { offset, partial, sessionId, agentId }
    this.agents = new Map();  // agentId -> agent
    this.spawns = new Map();  // toolUseId -> { parentId, sessionId, description, subagentType, prompt, ts, result, childId }
    this.childSpawn = new Map(); // child agentId -> spawn
    this.hookState = new Map(); // sessionId -> { ended, waiting, lastTs }
    this.hookOffset = 0;
    this.artifacts = new ArtifactStore(this.storeDir);
    this.version = 0;
  }

  rel(p) {
    if (!p) return '?';
    const r = path.relative(this.projectDir, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  }

  // ---------------------------------------------------------------- scanning

  /** Find transcript files. With `onlySession`, only that session's files. */
  discover(onlySession) {
    const out = [];
    for (const dir of transcriptDirs(this.projectDir, this.claudeDir)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const sessionId = n.slice(0, -6);
        if (onlySession && sessionId !== onlySession) continue;
        out.push({ file: path.join(dir, n), sessionId, agentId: sessionId, kind: 'main' });
        const subDir = path.join(dir, sessionId, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(subDir); } catch { /* no subagents */ }
        for (const s of subs) {
          const m = /^agent-(.+)\.jsonl$/.exec(s);
          if (m) out.push({ file: path.join(subDir, s), sessionId, agentId: m[1], kind: 'subagent', meta: path.join(subDir, `agent-${m[1]}.meta.json`) });
        }
      }
    }
    // Main transcripts first, so parents know their spawn calls before children link to them.
    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  }

  /** Read new data from all transcripts and hook events. Returns true when something changed. */
  refresh(onlySession) {
    let changed = false;
    const cutoff = this.maxAgeHours > 0 ? this.now() - this.maxAgeHours * 3600e3 : 0;
    for (const entry of this.discover(onlySession)) {
      let st;
      try { st = fs.statSync(entry.file); } catch { continue; }
      let fstate = this.files.get(entry.file);
      if (!fstate) {
        if (st.mtimeMs < cutoff) continue; // old history: skip until asked for
        fstate = { offset: 0, partial: '', ...entry };
        this.files.set(entry.file, fstate);
        this.ensureAgent(entry);
      }
      if (st.size < fstate.offset) { fstate.offset = 0; fstate.partial = ''; } // file was rewritten
      if (st.size === fstate.offset) continue;
      changed = this.readFile(fstate, st.size) || changed;
    }
    changed = this.readHooks() || changed;
    if (changed) this.version++;
    if (this.writeArtifacts) this.flushArtifacts();
    return changed;
  }

  ensureAgent(entry) {
    let a = this.agents.get(entry.agentId);
    if (!a) {
      a = newAgent(entry.agentId, entry.kind, entry.sessionId);
      this.agents.set(a.id, a);
    }
    a.transcript = entry.file;
    if (entry.meta) {
      try {
        const meta = JSON.parse(fs.readFileSync(entry.meta, 'utf8'));
        a.agentType = meta.agentType || a.agentType;
        a.description = meta.description || a.description;
        a.spawnToolUseId = meta.toolUseId || null;
      } catch { /* meta is optional */ }
    }
    return a;
  }

  readFile(fstate, size) {
    const fd = fs.openSync(fstate.file, 'r');
    let chunk;
    try {
      const len = size - fstate.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, fstate.offset);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    fstate.offset = size;
    const text = fstate.partial + chunk;
    const lines = text.split('\n');
    fstate.partial = lines.pop(); // keep an incomplete last line for the next read
    let changed = false;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      changed = this.ingest(line, fstate) || changed;
    }
    return changed;
  }

  /** Apply one transcript line to the model. */
  ingest(line, fstate) {
    let agentId = fstate.agentId;
    // Older Claude Code versions keep subagent ("sidechain") lines inside the main transcript.
    if (fstate.kind === 'main' && line.isSidechain && line.agentId) {
      agentId = line.agentId;
      if (!this.agents.has(agentId)) this.ensureAgent({ agentId, kind: 'subagent', sessionId: fstate.sessionId });
    }
    const a = this.agents.get(agentId);
    if (!a) return false;
    const ts = line.timestamp ? Date.parse(line.timestamp) : null;

    switch (line.type) {
      case 'custom-title': if (a.kind === 'main' && line.customTitle) a.name = line.customTitle; return true;
      case 'agent-name': if (a.kind === 'main' && line.agentName && !a.name) a.name = line.agentName; return true;
      case 'user': return this.onUser(a, line, ts);
      case 'assistant': return this.onAssistant(a, line, ts);
      default: return false;
    }
  }

  touch(a, ts) {
    if (!ts) return;
    if (!a.startedAt) a.startedAt = ts;
    if (!a.lastTs || ts > a.lastTs) a.lastTs = ts;
  }

  currentTurn(a, ts) {
    let t = a.turns[a.turns.length - 1];
    if (!t) { t = newTurn(1, a.description || '(no prompt)', ts, 'implicit'); a.turns.push(t); }
    return t;
  }

  closeTurn(a, t, status, ts) {
    if (t.status !== 'in_progress') return;
    t.status = status;
    t.endedAt = ts || a.lastTs;
    t.tasks = a.tasks.map((x) => ({ ...x }));
    a.pending.clear();
  }

  onUser(a, line, ts) {
    const msg = line.message || {};
    const content = msg.content;
    const results = Array.isArray(content) ? content.filter((c) => c && c.type === 'tool_result') : [];
    this.touch(a, ts);

    if (results.length) {
      const t = this.currentTurn(a, ts);
      for (const r of results) {
        const call = a.pending.get(r.tool_use_id);
        a.pending.delete(r.tool_use_id);
        const rtext = typeof r.content === 'string' ? r.content : textOf(r.content);
        if (r.is_error) {
          const tool = call ? call.name : 'tool';
          const message = clip(rtext, 400);
          // A rejected permission is not a failure of the agent's work, but it is still an issue worth listing.
          t.errors.push({ ts, tool, message });
          a.recent.push({ ts, text: `${tool} failed: ${clip(rtext, 80)}`, tool, error: true });
        }
        if (a.handback && a.handback === r.tool_use_id) {
          a.handback = null;
          this.closeTurn(a, t, r.is_error ? 'failed' : 'completed', ts);
        }
        const spawn = this.spawns.get(r.tool_use_id);
        if (spawn) {
          const tur = line.toolUseResult || {};
          const isAsync = tur.isAsync || tur.status === 'async_launched' || /Async agent launched/i.test(rtext);
          if (!isAsync) spawn.result = { isError: !!r.is_error, text: rtext, ts };
          const m = /agentId:\s*([a-z0-9]+)/i.exec(rtext);
          const childId = tur.agentId || (m && m[1]);
          if (childId && !spawn.childId) { spawn.childId = childId; this.childSpawn.set(childId, spawn); }
        }
        if (call && call.name === 'TaskCreate') {
          // TaskCreate returns the new id ("Task #3 created ..."). Map our local id to it.
          const m = /#?(\d+)/.exec(rtext);
          const task = a.tasks.find((x) => x.callId === r.tool_use_id);
          if (m && task) task.id = m[1];
        }
      }
      if (a.recent.length > RECENT_LIMIT) a.recent.splice(0, a.recent.length - RECENT_LIMIT);
      return true;
    }

    const text = textOf(content);
    if (line.isMeta || line.isCompactSummary || !text.trim()) return false;
    const last = a.turns[a.turns.length - 1];
    if (/^\[Request interrupted by user/.test(text)) {
      if (last && last.status === 'in_progress') {
        last.errors.push({ ts, tool: 'user', message: 'Interrupted by user' });
        this.closeTurn(a, last, 'failed', ts);
      }
      return true;
    }
    if (last && last.status === 'in_progress') this.closeTurn(a, last, last.errors.length && !last.finalText ? 'failed' : 'completed', ts);
    let prompt = text;
    let source = 'user';
    if (/^<task-notification>/.test(text)) { source = 'notification'; prompt = 'Background task notification'; }
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
    if (cmd) { source = 'command'; prompt = cmd[1].trim(); }
    a.turns.push(newTurn(a.turns.length + 1, clip(prompt, 2000), ts, source));
    if (a.kind === 'subagent' && !a.prompt) a.prompt = clip(text, 2000);
    return true;
  }

  onAssistant(a, line, ts) {
    const msg = line.message || {};
    this.touch(a, ts);
    if (msg.model && msg.model !== '<synthetic>') a.model = msg.model;
    const t = this.currentTurn(a, ts);
    if (t.status !== 'in_progress') { t.status = 'in_progress'; t.endedAt = null; } // continued after a stop hook
    if (msg.usage) {
      a.tokens.input += (msg.usage.input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0);
      a.tokens.output += msg.usage.output_tokens || 0;
    }
    if (line.isApiErrorMessage) {
      t.errors.push({ ts, tool: 'api', message: clip(textOf(msg.content), 400) });
      this.closeTurn(a, t, 'failed', ts);
      return true;
    }
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c.type === 'text' && c.text && c.text.trim()) t.finalText = c.text;
      if (c.type !== 'tool_use') continue;
      this.onToolUse(a, t, c, ts);
    }
    if (a.recent.length > RECENT_LIMIT) a.recent.splice(0, a.recent.length - RECENT_LIMIT);
    if (msg.stop_reason === 'end_turn' && a.pending.size === 0) this.closeTurn(a, t, 'completed', ts);
    return true;
  }

  onToolUse(a, t, c, ts) {
    const input = c.input || {};
    a.pending.set(c.id, { name: c.name, input, ts });
    t.tools[c.name] = (t.tools[c.name] || 0) + 1;
    a.recent.push({ ts, text: describeTool(c.name, input, (p) => this.rel(p)), tool: c.name });

    const kind = FILE_TOOLS[c.name];
    const fp = input.file_path || input.notebook_path;
    if (kind && fp) {
      const f = t.files[fp] || (t.files[fp] = { read: 0, edit: 0, write: 0, lastTs: ts });
      f[kind]++;
      f.lastTs = ts;
    }
    if (/handback/i.test(c.name)) {
      // Newer subagents report back through a SubagentHandback call instead of a final text message.
      t.finalText = input.message || input.summary || input.result || t.finalText;
      a.handback = c.id;
    }
    if (SPAWN_TOOLS.has(c.name)) {
      this.spawns.set(c.id, {
        parentId: a.id, sessionId: a.sessionId, ts,
        description: input.description || '', subagentType: input.subagent_type || 'general-purpose',
        prompt: input.prompt || '', result: null, childId: null,
      });
      t.subagents.push(c.id);
    }
    this.applyTaskTool(a, c);
  }

  /** Track task lists from TodoWrite, TaskCreate/TaskUpdate and the desktop app's update_plan. */
  applyTaskTool(a, c) {
    const input = c.input || {};
    if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
      a.tasks = input.todos.map((x, i) => ({ id: String(x.id || i + 1), title: x.content || x.subject || '', status: normStatus(x.status) }));
    } else if (c.name === 'TaskCreate') {
      a.taskSeq++;
      a.tasks.push({ id: String(a.taskSeq), callId: c.id, title: input.subject || input.description || '', status: 'pending' });
    } else if (c.name === 'TaskUpdate') {
      const task = a.tasks.find((x) => x.id === String(input.taskId));
      if (task) {
        if (input.status) task.status = normStatus(input.status);
        if (input.subject) task.title = input.subject;
      }
    } else if (c.name === 'mcp__ccd_turn__update_plan') {
      if (Array.isArray(input.items)) {
        a.tasks = input.items.map((x, i) => ({ id: String(i + 1), title: x.content || '', status: normStatus(x.status) }));
        return;
      }
      const at = a.tasks.findIndex((x) => x.status === 'in_progress');
      if (input.advance && at >= 0) {
        a.tasks[at].status = 'completed';
        const next = a.tasks.findIndex((x) => x.status === 'pending');
        if (next >= 0) a.tasks[next].status = 'in_progress';
      }
      for (const n of input.done || []) if (a.tasks[n - 1]) a.tasks[n - 1].status = 'completed';
      if (input.start && a.tasks[input.start - 1]) {
        a.tasks.forEach((x) => { if (x.status === 'in_progress') x.status = 'pending'; });
        a.tasks[input.start - 1].status = 'in_progress';
      }
    } else if (c.name === 'mcp__ccd_turn__wrap_up') {
      a.tasks.forEach((x) => { if (x.status === 'in_progress') x.status = 'completed'; });
    }
  }

  readHooks() {
    const file = path.join(this.storeDir, 'hooks.jsonl');
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (st.size < this.hookOffset) this.hookOffset = 0;
    if (st.size === this.hookOffset) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - this.hookOffset);
    try { fs.readSync(fd, buf, 0, buf.length, this.hookOffset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return false;
    this.hookOffset += Buffer.byteLength(text.slice(0, end + 1));
    for (const raw of text.slice(0, end).split('\n')) {
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      const s = this.hookState.get(ev.session_id) || { ended: false, waiting: null, lastTs: 0 };
      s.lastTs = ev.ts || s.lastTs;
      switch (ev.hook_event_name) {
        case 'SessionEnd': s.ended = true; s.waiting = null; break;
        case 'SessionStart': case 'UserPromptSubmit': s.ended = false; s.waiting = null; break;
        case 'Notification':
          s.waiting = /permission|waiting/i.test(ev.message || '') ? clip(ev.message, 120) : s.waiting; break;
        case 'PreToolUse': case 'PostToolUse': case 'Stop': case 'SubagentStop': s.waiting = null; break;
        default: break;
      }
      this.hookState.set(ev.session_id, s);
    }
    return true;
  }

  // ---------------------------------------------------------------- status

  /** Link each subagent to the spawn call that started it. */
  spawnFor(a) {
    if (a.spawnToolUseId && this.spawns.has(a.spawnToolUseId)) return this.spawns.get(a.spawnToolUseId);
    return this.childSpawn.get(a.id) || null;
  }

  statusOf(a) {
    const now = this.now();
    const last = a.turns[a.turns.length - 1];
    const hook = this.hookState.get(a.sessionId);
    const spawn = a.kind === 'subagent' ? this.spawnFor(a) : null;

    if (spawn && spawn.result && last && last.status === 'in_progress') {
      if (!last.finalText) last.finalText = spawn.result.text;
      if (spawn.result.isError) last.errors.push({ ts: spawn.result.ts, tool: 'Agent', message: clip(spawn.result.text, 400) });
      this.closeTurn(a, last, spawn.result.isError ? 'failed' : 'completed', spawn.result.ts);
    }
    if (!last) return { status: 'idle', activity: 'Starting' };

    if (last.status === 'in_progress') {
      if (a.kind === 'main' && hook && hook.waiting) return { status: 'idle', activity: hook.waiting };
      if (a.kind === 'main' && hook && hook.ended) return { status: 'completed', activity: 'Session ended' };
      const pend = [...a.pending.values()];
      const age = now - (a.lastTs || 0);
      const limit = pend.length ? STALE_TOOL_MS : STALE_THINK_MS;
      if (age > SESSION_END_MS) {
        return a.kind === 'main'
          ? { status: 'completed', activity: 'Session ended (last turn unfinished)' }
          : { status: 'failed', activity: 'Stopped without a result' };
      }
      if (age > limit) return { status: 'idle', activity: `No activity for ${Math.round(age / 60e3)} min` };
      if (pend.length) {
        const p = pend[pend.length - 1];
        return { status: 'running', activity: describeTool(p.name, p.input, (x) => this.rel(x)) };
      }
      return { status: 'running', activity: 'Thinking' };
    }
    if (a.kind === 'subagent') return { status: last.status, activity: last.status === 'failed' ? 'Failed' : 'Done' };
    const ended = (hook && hook.ended) || now - (a.lastTs || 0) > SESSION_END_MS;
    const interrupted = last.errors.length && last.errors[last.errors.length - 1].tool === 'user';
    if (last.status === 'failed' && !(ended && interrupted)) return { status: 'failed', activity: last.errors.length ? clip(last.errors[last.errors.length - 1].message, 80) : 'Failed' };
    if (ended) return { status: 'completed', activity: 'Session ended' };
    return { status: 'idle', activity: 'Waiting for the user' };
  }

  // ---------------------------------------------------------------- artifacts

  flushArtifacts() {
    this.artifacts.begin();
    for (const a of this.agents.values()) {
      this.statusOf(a); // may close a subagent turn
      for (const t of a.turns) {
        if (t.status === 'in_progress') continue;
        // Skip turns that did not change since the last write (child status can still change).
        const sig = `${t.endedAt}:${t.status}:${t.subagents.map((id) => (this.spawns.get(id).result ? 1 : 0)).join('')}`;
        if (t.artifactSig === sig) continue;
        this.artifacts.write(this.buildArtifact(a, t));
        t.artifactSig = sig;
      }
    }
    this.artifacts.commit();
  }

  buildArtifact(a, t) {
    const files = Object.entries(t.files).map(([p, f]) => ({ path: this.rel(p), ...f }));
    const tasks = t.tasks || [];
    const subagents = t.subagents.map((id) => {
      const s = this.spawns.get(id);
      const child = [...this.agents.values()].find((x) => this.spawnFor(x) === s);
      return { id: child ? child.id : id, name: s.description, type: s.subagentType, status: s.result ? (s.result.isError ? 'failed' : 'completed') : (child ? this.statusOf(child).status : 'running') };
    });
    return {
      id: `${a.id.slice(0, 12)}-t${t.index}`,
      agentId: a.id, agentName: this.nameOf(a), agentType: a.agentType, kind: a.kind,
      sessionId: a.sessionId, parentId: this.parentOf(a), turn: t.index,
      status: t.status, prompt: t.prompt, source: t.source,
      startedAt: t.startedAt, endedAt: t.endedAt,
      durationMs: t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null,
      summary: clip(t.finalText, 6000) || (t.status === 'failed' ? 'The agent stopped before it gave a summary.' : 'No summary text.'),
      filesModified: files.filter((f) => f.edit || f.write).map(({ path: p, edit, write }) => ({ path: p, edits: edit, writes: write })),
      filesRead: files.filter((f) => f.read && !f.edit && !f.write).map((f) => f.path),
      tasks: {
        completed: tasks.filter((x) => x.status === 'completed').map((x) => x.title),
        in_progress: tasks.filter((x) => x.status === 'in_progress').map((x) => x.title),
        pending: tasks.filter((x) => x.status === 'pending').map((x) => x.title),
      },
      subagents,
      tools: t.tools,
      issues: t.errors,
      model: a.model,
    };
  }

  // ---------------------------------------------------------------- snapshot

  nameOf(a) {
    if (a.kind === 'main') return a.name || `Session ${a.id.slice(0, 8)}`;
    const s = this.spawnFor(a);
    return a.description || (s && s.description) || `Subagent ${a.id.slice(0, 8)}`;
  }

  parentOf(a) {
    if (a.kind === 'main') return null;
    const s = this.spawnFor(a);
    return s ? s.parentId : a.sessionId;
  }

  agentView(a) {
    const { status, activity } = this.statusOf(a);
    const files = {};
    const tools = {};
    const errors = [];
    for (const t of a.turns) {
      for (const [p, f] of Object.entries(t.files)) {
        const g = files[p] || (files[p] = { read: 0, edit: 0, write: 0, lastTs: 0 });
        g.read += f.read; g.edit += f.edit; g.write += f.write; g.lastTs = Math.max(g.lastTs, f.lastTs || 0);
      }
      for (const [k, v] of Object.entries(t.tools)) tools[k] = (tools[k] || 0) + v;
      errors.push(...t.errors);
    }
    const last = a.turns[a.turns.length - 1];
    const done = a.tasks.filter((x) => x.status === 'completed').length;
    const spawn = a.kind === 'subagent' ? this.spawnFor(a) : null;
    return {
      id: a.id, kind: a.kind, sessionId: a.sessionId, parentId: this.parentOf(a),
      name: this.nameOf(a), agentType: a.agentType || (spawn && spawn.subagentType),
      status, activity,
      prompt: last ? last.prompt : '',
      startedAt: a.startedAt, lastActivity: a.lastTs,
      endedAt: status === 'completed' || status === 'failed' ? (last && last.endedAt) || a.lastTs : null,
      model: a.model, tokens: a.tokens,
      tasks: a.tasks.map(({ id, title, status: s }) => ({ id, title, status: s })),
      progress: { done, total: a.tasks.length },
      files: Object.entries(files)
        .map(([p, f]) => ({ path: this.rel(p), ...f }))
        .sort((x, y) => y.lastTs - x.lastTs),
      tools, toolCalls: Object.values(tools).reduce((s, n) => s + n, 0),
      errors: errors.slice(-20),
      turns: a.turns.length,
      completedTurns: a.turns.filter((t) => t.status !== 'in_progress').length,
      summary: last && last.status !== 'in_progress' ? clip(last.finalText, 600) : '',
      recent: a.recent.slice(-15),
    };
  }

  /** Spawn calls without a transcript of their own (older versions, or a child not yet written). */
  virtualAgents(views) {
    const linked = new Set();
    for (const a of this.agents.values()) { const s = this.spawnFor(a); if (s) linked.add(s); }
    const out = [];
    for (const [id, s] of this.spawns) {
      if (linked.has(s) || !views.some((v) => v.id === s.parentId)) continue;
      const age = this.now() - s.ts;
      const status = s.result ? (s.result.isError ? 'failed' : 'completed')
        : age > SESSION_END_MS ? 'completed' : age > STALE_TOOL_MS ? 'idle' : 'running';
      const activity = s.result ? (s.result.isError ? 'Failed' : 'Done')
        : age > SESSION_END_MS ? 'Ended (no transcript or result found)' : status === 'idle' ? 'No transcript yet' : 'Working (no transcript yet)';
      out.push({
        id: `spawn-${id.slice(-10)}`, kind: 'subagent', sessionId: s.sessionId, parentId: s.parentId,
        name: s.description || 'Subagent', agentType: s.subagentType, status, activity,
        prompt: clip(s.prompt, 2000), startedAt: s.ts, lastActivity: s.result ? s.result.ts : s.ts,
        endedAt: s.result ? s.result.ts : null, model: null, tokens: { input: 0, output: 0 },
        tasks: [], progress: { done: 0, total: 0 }, files: [], tools: {}, toolCalls: 0,
        errors: s.result && s.result.isError ? [{ ts: s.result.ts, tool: 'Agent', message: clip(s.result.text, 400) }] : [],
        turns: 1, completedTurns: s.result ? 1 : 0, summary: s.result ? clip(s.result.text, 600) : '', recent: [],
      });
    }
    return out;
  }

  snapshot() {
    const cutoff = this.maxAgeHours > 0 ? this.now() - this.maxAgeHours * 3600e3 : 0;
    let agents = [...this.agents.values()]
      .filter((a) => a.turns.length && (a.lastTs || 0) >= cutoff)
      .map((a) => this.agentView(a));
    agents = agents.concat(this.virtualAgents(agents));
    agents.sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0));

    const count = (k) => agents.filter((a) => a.status === k).length;
    const tasks = [];
    for (const a of agents) {
      if (a.kind === 'subagent') {
        tasks.push({ id: `agent:${a.id}`, title: a.name, status: a.status === 'running' || a.status === 'idle' ? 'in_progress' : a.status, agentId: a.parentId, ownerId: a.id, source: 'delegation' });
      }
      for (const t of a.tasks) tasks.push({ id: `${a.id}:${t.id}`, title: t.title, status: t.status, agentId: a.id, source: 'todo' });
    }
    const fileMap = new Map();
    for (const a of agents) {
      for (const f of a.files) {
        const e = fileMap.get(f.path) || { path: f.path, agents: [], read: 0, edit: 0, write: 0, lastTs: 0 };
        e.agents.push({ id: a.id, name: a.name, status: a.status, read: f.read, edit: f.edit, write: f.write });
        e.read += f.read; e.edit += f.edit; e.write += f.write; e.lastTs = Math.max(e.lastTs, f.lastTs);
        fileMap.set(f.path, e);
      }
    }
    const activity = [];
    for (const a of agents) for (const r of a.recent) activity.push({ ...r, agentId: a.id, agentName: a.name });
    activity.sort((x, y) => (y.ts || 0) - (x.ts || 0));

    const artifacts = this.artifacts.list();
    return {
      project: { dir: this.projectDir, name: path.basename(this.projectDir) },
      generatedAt: this.now(),
      version: this.version,
      summary: {
        total: agents.length,
        main: agents.filter((a) => a.kind === 'main').length,
        subagents: agents.filter((a) => a.kind === 'subagent').length,
        running: count('running'), idle: count('idle'), completed: count('completed'), failed: count('failed'),
        tasks: {
          pending: tasks.filter((t) => t.status === 'pending').length,
          in_progress: tasks.filter((t) => t.status === 'in_progress').length,
          completed: tasks.filter((t) => t.status === 'completed').length,
          failed: tasks.filter((t) => t.status === 'failed').length,
        },
        files: fileMap.size,
        modifiedFiles: [...fileMap.values()].filter((f) => f.edit || f.write).length,
        artifacts: artifacts.length,
      },
      agents,
      tasks,
      files: [...fileMap.values()].sort((x, y) => y.lastTs - x.lastTs),
      activity: activity.slice(0, 150),
      artifacts: artifacts.slice(0, 200),
    };
  }
}

module.exports = { Monitor, describeTool, STALE_TOOL_MS, STALE_THINK_MS, SESSION_END_MS };
