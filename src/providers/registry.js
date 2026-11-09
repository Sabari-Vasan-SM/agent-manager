'use strict';

const { ClaudeCodeProvider } = require('./claude');
const { AntigravityProvider } = require('./antigravity');
const { CodexProvider } = require('./codex');
const { CursorProvider } = require('./cursor');
const { WindsurfProvider } = require('./windsurf');
const { AiderProvider } = require('./aider');

const PROVIDER_CLASSES = {
  'claude-code': ClaudeCodeProvider,
  claude: ClaudeCodeProvider,
  antigravity: AntigravityProvider,
  agy: AntigravityProvider,
  codex: CodexProvider,
  cursor: CursorProvider,
  windsurf: WindsurfProvider,
  cascade: WindsurfProvider,
  aider: AiderProvider,
};

/**
 * Instantiate all default providers.
 */
function createDefaultProviders(opts = {}) {
  return [
    new ClaudeCodeProvider(opts),
    new AntigravityProvider(opts),
    new CodexProvider(opts),
    new CursorProvider(opts),
    new WindsurfProvider(opts),
    new AiderProvider(opts),
  ];
}

/**
 * Detect which providers have transcripts or configs for the given project.
 */
function detectProviders(projectDir, opts = {}) {
  const all = createDefaultProviders(opts);
  const active = all.filter((p) => {
    try {
      if (p.isAvailable(projectDir)) {
        const files = p.discover(projectDir, opts);
        return files.length > 0;
      }
      return false;
    } catch {
      return false;
    }
  });

  // If none detected with existing transcripts, return all available providers
  // so newly launched sessions can be monitored dynamically.
  if (active.length === 0) {
    return all.filter((p) => {
      try { return p.isAvailable(projectDir); } catch { return false; }
    });
  }

  return active;
}

/**
 * Resolve provider list from options, names or auto-detection.
 * @param {string|string[]|BaseProvider[]} selection
 * @param {string} projectDir
 * @param {object} opts
 */
function resolveProviders(selection, projectDir, opts = {}) {
  if (Array.isArray(selection) && selection.length && typeof selection[0] === 'object') {
    return selection;
  }

  if (typeof selection === 'string') {
    const names = selection.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const resolved = [];
    for (const name of names) {
      const Cls = PROVIDER_CLASSES[name];
      if (Cls) resolved.push(new Cls(opts));
      else throw new Error(`Unknown provider "${name}". Available: claude, antigravity, codex, cursor, windsurf, aider`);
    }
    return resolved;
  }

  if (Array.isArray(selection) && selection.length) {
    return selection.map((name) => {
      if (typeof name === 'object') return name;
      const Cls = PROVIDER_CLASSES[name.toLowerCase()];
      if (Cls) return new Cls(opts);
      throw new Error(`Unknown provider "${name}".`);
    });
  }

  // Default: detect all active providers for the project
  const detected = detectProviders(projectDir, opts);
  return detected.length ? detected : createDefaultProviders(opts);
}

module.exports = {
  PROVIDER_CLASSES,
  createDefaultProviders,
  detectProviders,
  resolveProviders,
};
