'use strict';

/**
 * BaseProvider & Canonical Tool Taxonomies
 *
 * Provides the base class for AI tool providers and canonical tool mapping.
 */

const CANONICAL_TOOLS = {
  // Claude Code
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'bash',
  PowerShell: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Agent: 'agent',
  Task: 'agent',
  WebFetch: 'fetch',
  WebSearch: 'search',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',

  // Antigravity (AGY)
  read_file: 'read',
  read_resource: 'read',
  edit_file: 'edit',
  write_file: 'write',
  run_command: 'bash',
  search_web: 'search',
  invoke_subagent: 'agent',
  define_subagent: 'agent',
  manage_task: 'plan',

  // Codex CLI
  shell: 'bash',
  apply_patch: 'edit',
  update_plan: 'plan',
  spawn_agent: 'agent',

  // Windsurf Cascade
  code_action: 'write',
  command_action: 'bash',
  view_file: 'read',
  edit_file_part: 'edit',
};

const FILE_TOOLS = {
  // Claude / Cursor
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  // Antigravity
  read_file: 'read',
  edit_file: 'edit',
  write_file: 'write',
  // Codex
  apply_patch: 'edit',
  // Windsurf
  code_action: 'write',
  view_file: 'read',
  edit_file_part: 'edit',
};

const SPAWN_TOOLS = new Set([
  'Agent',
  'Task',
  'invoke_subagent',
  'spawn_agent',
]);

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Universal describeTool helper that understands tools across Claude, Antigravity,
 * Codex CLI, Cursor, Windsurf, and generic tools.
 */
function describeTool(name, input = {}, rel = (p) => p) {
  const f = input.file_path || input.notebook_path || input.path || input.Path || input.filePath;
  switch (name) {
    // Read
    case 'Read':
    case 'read_file':
    case 'read_resource':
    case 'view_file':
      return `Reading ${rel(f)}`;

    // Edit
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'edit_file':
    case 'edit_file_part':
    case 'apply_patch':
      return `Editing ${rel(f)}`;

    // Write
    case 'Write':
    case 'write_file':
    case 'code_action':
      return `Writing ${rel(f)}`;

    // Shell / Command
    case 'Bash':
    case 'PowerShell':
    case 'run_command':
    case 'command_action':
    case 'shell': {
      const cmd = input.CommandLine || input.command || input.description || input.toolSummary;
      return `Running: ${clip(cmd, 70)}`;
    }

    // Search
    case 'Grep':
    case 'search_web':
    case 'search_strings':
      return `Searching for "${clip(input.pattern || input.query, 40)}"`;
    case 'Glob':
      return `Finding files ${clip(input.pattern, 40)}`;

    // Delegation / Subagents
    case 'Agent':
    case 'Task':
    case 'invoke_subagent':
    case 'spawn_agent': {
      const desc = input.description || input.Role || input.prompt || input.TypeName;
      return `Delegating: ${clip(desc, 60)}`;
    }

    // Web
    case 'WebFetch':
      return `Fetching ${clip(input.url, 60)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(input.query, 50)}`;

    // Plan / Tasks
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'manage_task':
    case 'update_plan':
    case 'mcp__ccd_turn__update_plan':
      return 'Updating the task list';

    default:
      return `Using ${name.replace(/^mcp__.+?__/, '')}`;
  }
}

/**
 * Base class for all AI tool providers.
 */
class BaseProvider {
  /**
   * @param {string} name - short unique id, e.g. 'claude-code', 'antigravity', 'codex'
   * @param {string} displayName - human-readable name, e.g. 'Claude Code', 'Antigravity'
   * @param {object} [opts]
   */
  constructor(name, displayName, opts = {}) {
    this.name = name;
    this.displayName = displayName;
    this.opts = opts;
  }

  /**
   * Discover transcript files for this provider.
   * @param {string} projectDir - project directory
   * @param {object} [opts] - { onlySession }
   * @returns {Array<{ file: string, sessionId: string, agentId: string, kind: 'main'|'subagent', provider: string, meta?: string, extra?: any }>}
   */
  discover(projectDir, opts = {}) {
    return [];
  }

  /**
   * Parse a raw transcript line (already JSON-parsed if JSONL) into normalized events.
   * Can return null, a single event object, or an array of event objects.
   * @param {object|string} raw - parsed JSON object or raw line
   * @param {object} fstate - file tracking state
   * @returns {object|Array<object>|null}
   */
  parseLine(raw, fstate) {
    return raw;
  }

  /**
   * Describe a tool call specific to this provider.
   */
  describeTool(name, input = {}, rel = (p) => p) {
    return describeTool(name, input, rel);
  }

  /**
   * Check if transcripts or configs for this provider exist.
   * @param {string} projectDir
   * @returns {boolean}
   */
  isAvailable(projectDir) {
    return false;
  }
}

module.exports = {
  BaseProvider,
  CANONICAL_TOOLS,
  FILE_TOOLS,
  SPAWN_TOOLS,
  describeTool,
  clip,
};
