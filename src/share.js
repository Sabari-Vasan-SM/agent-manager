'use strict';
/**
 * Public URL for the dashboard through a tunnel.
 *   1. cloudflared  (Cloudflare quick tunnel, https://*.trycloudflare.com) when it is on PATH
 *   2. ssh          (localhost.run, https://*.lhr.life) — ssh is on most systems
 */
const { spawn, spawnSync } = require('child_process');

function onPath(cmd) {
  const probe = process.platform === 'win32' ? spawnSync('where', [cmd]) : spawnSync('which', [cmd]);
  return probe.status === 0;
}

function waitForUrl(child, regex, label, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${label}: no public URL after ${timeoutMs / 1000}s`)); }, timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      const m = regex.exec(buf);
      if (m) { clearTimeout(timer); resolve({ url: m[0], provider: label, stop: () => child.kill() }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited (code ${code}): ${buf.trim().slice(-300)}`)); });
  });
}

async function startTunnel(port, prefer) {
  const tries = [];
  if ((!prefer || prefer === 'cloudflared') && onPath('cloudflared')) {
    tries.push(() => waitForUrl(
      spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]),
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, 'cloudflared'));
  }
  if ((!prefer || prefer === 'ssh') && onPath('ssh')) {
    tries.push(() => waitForUrl(
      spawn('ssh', ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
        '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run']),
      // Match only the tunnel line; the welcome text has other localhost.run links (admin, docs).
      /https:\/\/[a-z0-9-]+\.lhr\.life/, 'localhost.run'));
  }
  if (!tries.length) throw new Error('No tunnel tool found. Install cloudflared or OpenSSH to get a public URL.');
  let last;
  for (const t of tries) {
    try { return await t(); } catch (e) { last = e; }
  }
  throw last;
}

module.exports = { startTunnel };
