'use strict';
/**
 * Monitor: reads AI agent transcripts for a project across multiple providers
 * (Claude Code, Antigravity, OpenAI Codex CLI, Cursor, Windsurf, Aider)
 * and builds a live model of every agent (main sessions and subagents),
 * their turns, tasks, files and errors.
 *
 * Reading is incremental: each file keeps a byte offset, so refresh() is cheap.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, storeDir } = require('./paths');
const { ArtifactStore } = require('./artifacts');
const {
  CANONICAL_TOOLS,
  FILE_TOOLS,
  SPAWN_TOOLS,
  describeTool,
  clip,
} = require('./providers/base');
const { resolveProviders } = require('./providers/registry');

const STALE_TOOL_MS = 10 * 60e3;   // a tool call with no result for this long = stalled
const STALE_THINK_MS = 3 * 60e3;   // no new line while the model "thinks" for this long = stalled
const SESSION_END_MS = 30 * 60e3;  // an idle main session with no activity for this long = completed
const RECENT_LIMIT = 40;

function newAgent(id, kind, sessionId, provider = 'claude-code', providerName = 'Claude Code') {
  return {
    id, kind, sessionId,
    parentId: kind === 'main' ? null : sessionId,
    spawnToolUseId: null,
    provider, providerName,
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

function normStatus(s) {
  if (s === 'completed' || s === 'done' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'active' || s === 'working') return 'in_progress';
  if (s === 'failed' || s === 'cancelled' || s === 'deleted' || s === 'error') return 'failed';
  return 'pending';
}

class Monitor {
  /**
   * @param {object} opts
   * @param {string} opts.projectDir   project root
   * @param {string|Array} [opts.providers] provider name(s) or instances (default: auto-detected)
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

    // Initialize AI Tool Providers
    this.providers = resolveProviders(opts.providers, this.projectDir, { claudeDir: this.claudeDir });
    this.providerMap = new Map(this.providers.map((p) => [p.name, p]));
    this.defaultProvider = this.providers[0] || null;

    this.files = new Map();   // path -> { offset, partial, sessionId, agentId, provider, isMarkdown }
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

  /** Find transcript files across all active providers. With `onlySession`, only that session's files. */
  discover(onlySession) {
    const out = [];
    for (const provider of this.providers) {
      try {
        const list = provider.discover(this.projectDir, { onlySession });
        out.push(...list);
      } catch {
        // Continue discovering other providers
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
      const provider = entry.provider || 'claude-code';
      const provObj = this.providerMap.get(provider);
      const providerName = provObj ? provObj.displayName : provider;
      a = newAgent(entry.agentId, entry.kind, entry.sessionId, provider, providerName);
      this.agents.set(a.id, a);
    }
    a.transcript = entry.file;
    if (entry.meta) {
      try {
        const meta = JSON.parse(fs.readFileSync(entry.meta, 'utf8'));
        a.agentType = meta.agentType || (meta.subagentDescriptor && meta.subagentDescriptor.typeName) || a.agentType;
        a.description = meta.description || (meta.subagentDescriptor && meta.subagentDescriptor.role) || a.description;
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
    const provider = this.providerMap.get(fstate.provider) || this.defaultProvider;

    for (const raw of lines) {
      if (!raw.trim()) continue;
      let parsed = raw;
      if (!fstate.isMarkdown) {
        try { parsed = JSON.parse(raw); } catch { continue; }
      }
      const events = provider && provider.parseLine ? provider.parseLine(parsed, fstate) : parsed;
      if (!events) continue;
      if (Array.isArray(events)) {
        for (const ev of events) {
          if (ev) changed = this.ingest(ev, fstate) || changed;
        }
      } else {
        changed = this.ingest(events, fstate) || changed;
      }
    }
    return changed;
  }

  /** Apply one normalized transcript event to the model. */
  ingest(line, fstate) {
    let agentId = fstate.agentId;
    // Subagent ("sidechain") lines inside the main transcript
    if (fstate.kind === 'main' && line.isSidechain && line.agentId) {
      agentId = line.agentId;
      if (!this.agents.has(agentId)) {
        this.ensureAgent({ agentId, kind: 'subagent', sessionId: fstate.sessionId, provider: fstate.provider });
      }
    }
    const a = this.agents.get(agentId);
    if (!a) return false;
    const ts = line.timestamp ? Date.parse(line.timestamp) : null;

    switch (line.type) {
      case 'custom-title':
        if (line.customTitle) a.name = line.customTitle;
        return true;
      case 'agent-name':
        if (line.agentName && !a.name) a.name = line.agentName;
        return true;
      case 'user':
        return this.onUser(a, line, ts);
      case 'assistant':
        return this.onAssistant(a, line, ts);
      default:
        return false;
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
          const m = /agentId:\s*([a-z0-9-]+)/i.exec(rtext) || /"conversationId":\s*"([^"]+)"/i.exec(rtext);
          const childId = tur.agentId || (m && m[1]);
          if (childId && !spawn.childId) { spawn.childId = childId; this.childSpawn.set(childId, spawn); }
        }
        if (call && (call.name === 'TaskCreate' || call.name === 'manage_task')) {
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
    if (/^\[Request interrupted by user/i.test(text)) {
      if (last && last.status === 'in_progress') {
        last.errors.push({ ts, tool: 'user', message: 'Interrupted by user' });
        this.closeTurn(a, last, 'failed', ts);
      }
      return true;
    }
    if (last && last.status === 'in_progress') {
      this.closeTurn(a, last, last.errors.length && !last.finalText ? 'failed' : 'completed', ts);
    }
    let prompt = text;
    let source = 'user';
    if (/^<task-notification>/i.test(text)) { source = 'notification'; prompt = 'Background task notification'; }
    const cmd = /<command-name>([^<]+)<\/command-name>/i.exec(text);
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
    if (t.status !== 'in_progress') { t.status = 'in_progress'; t.endedAt = null; }
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
    const fp = input.file_path || input.notebook_path || input.path || input.Path || input.filePath;
    if (kind && fp) {
      const f = t.files[fp] || (t.files[fp] = { read: 0, edit: 0, write: 0, lastTs: ts });
      f[kind]++;
      f.lastTs = ts;
    }
    if (/handback/i.test(c.name)) {
      t.finalText = input.message || input.summary || input.result || t.finalText;
      a.handback = c.id;
    }
    if (SPAWN_TOOLS.has(c.name)) {
      const desc = input.description || input.Role || input.TypeName || input.prompt || '';
      const stype = input.subagent_type || input.TypeName || 'general-purpose';
      this.spawns.set(c.id, {
        parentId: a.id, sessionId: a.sessionId, ts,
        description: desc, subagentType: stype,
        prompt: input.prompt || input.Prompt || '', result: null, childId: null,
      });
      t.subagents.push(c.id);
    }
    this.applyTaskTool(a, c);
  }

  /** Track task lists from TodoWrite, TaskCreate/Update, update_plan, etc. */
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
    } else if (c.name === 'update_plan' && Array.isArray(input.plan || input.items || input.steps)) {
      const list = input.plan || input.items || input.steps;
      a.tasks = list.map((x, i) => ({
        id: String(x.id || i + 1),
        title: typeof x === 'string' ? x : (x.step || x.content || x.title || ''),
        status: normStatus(x.status),
      }));
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
      this.statusOf(a);
      for (const t of a.turns) {
        if (t.status === 'in_progress') continue;
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
      provider: a.provider, providerName: a.providerName,
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
      provider: a.provider, providerName: a.providerName,
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

  /** Spawn calls without a transcript of their own. */
  virtualAgents(views) {
    const linked = new Set();
    for (const a of this.agents.values()) { const s = this.spawnFor(a); if (s) linked.add(s); }
    const out = [];
    for (const [id, s] of this.spawns) {
      if (linked.has(s) || !views.some((v) => v.id === s.parentId)) continue;
      const parentAgent = this.agents.get(s.parentId);
      const prov = parentAgent ? parentAgent.provider : 'claude-code';
      const provName = parentAgent ? parentAgent.providerName : 'Claude Code';
      const age = this.now() - s.ts;
      const status = s.result ? (s.result.isError ? 'failed' : 'completed')
        : age > SESSION_END_MS ? 'completed' : age > STALE_TOOL_MS ? 'idle' : 'running';
      const activity = s.result ? (s.result.isError ? 'Failed' : 'Done')
        : age > SESSION_END_MS ? 'Ended (no transcript or result found)' : status === 'idle' ? 'No transcript yet' : 'Working (no transcript yet)';
      out.push({
        id: `spawn-${id.slice(-10)}`, kind: 'subagent', sessionId: s.sessionId, parentId: s.parentId,
        provider: prov, providerName: provName,
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
    for (const a of agents) for (const r of a.recent) activity.push({ ...r, agentId: a.id, agentName: a.name, provider: a.provider });
    activity.sort((x, y) => (y.ts || 0) - (x.ts || 0));

    const artifacts = this.artifacts.list();
    const activeProviders = [...new Set(agents.map((a) => a.provider))];

    return {
      project: { dir: this.projectDir, name: path.basename(this.projectDir) },
      providers: this.providers.map((p) => ({ id: p.name, name: p.displayName })),
      generatedAt: this.now(),
      version: this.version,
      summary: {
        total: agents.length,
        main: agents.filter((a) => a.kind === 'main').length,
        subagents: agents.filter((a) => a.kind === 'subagent').length,
        providers: activeProviders.length,
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

module.exports = {
  Monitor,
  describeTool,
  STALE_TOOL_MS,
  STALE_THINK_MS,
  SESSION_END_MS,
  CANONICAL_TOOLS,
  FILE_TOOLS,
  SPAWN_TOOLS,
};
