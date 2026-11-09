'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The Claude Code config folder that holds `projects/<encoded-path>/*.jsonl` transcripts. */
function claudeDir() {
  return process.env.AIM_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code names a project's transcript folder after its path, with every non-alphanumeric char as "-". */
function encodeProject(projectDir) {
  return path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-');
}

/** All transcript folders for a project. The match ignores case, because Windows drive letters vary (d-- vs D--). */
function transcriptDirs(projectDir, cdir = claudeDir()) {
  const base = path.join(cdir, 'projects');
  const want = encodeProject(projectDir).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names.filter((n) => n.toLowerCase() === want).map((n) => path.join(base, n));
}

/** Walk up from `start` to the nearest folder that looks like a project root. */
function findProjectRoot(start = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = path.resolve(start);
  for (;;) {
    for (const marker of ['.ai-manager', '.claude', '.git']) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

function storeDir(projectDir) {
  return process.env.AIM_STORE_DIR ? path.resolve(process.env.AIM_STORE_DIR) : path.join(projectDir, '.ai-manager');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { claudeDir, encodeProject, transcriptDirs, findProjectRoot, storeDir, ensureDir };
