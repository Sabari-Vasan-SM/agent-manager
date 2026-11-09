'use strict';
/**
 * Dashboard HTTP server. No dependencies.
 *   GET /                     dashboard page
 *   GET /api/state            full snapshot (JSON)
 *   GET /api/stream           live snapshots (Server-Sent Events)
 *   GET /api/artifacts/:id    one artifact (JSON, with markdown)
 *   GET /api/artifacts/:id.md one artifact as a Markdown download
 * With a token, every request needs ?token=<t> once (a cookie keeps it after that).
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PAGE = path.join(__dirname, 'dashboard.html');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function createServer(monitor, { token = null, pollMs = 1000 } = {}) {
  const clients = new Set();
  let snap = null;
  let snapJson = '';

  function rebuild() {
    snap = monitor.snapshot();
    // generatedAt changes every time; compare without it so we only push real changes.
    const { generatedAt, ...rest } = snap;
    void generatedAt;
    const body = JSON.stringify(rest);
    const changed = body !== snapJson;
    snapJson = body;
    return changed;
  }

  function broadcast() {
    const data = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(data);
  }

  monitor.refresh();
  rebuild();
  let ticks = 0;
  const timer = setInterval(() => {
    try {
      monitor.refresh();
      ticks++;
      // Status depends on the clock too (stale agents), so rebuild at least every 5 s.
      if (rebuild() || ticks % 5 === 0) broadcast();
    } catch (e) {
      process.stderr.write(`refresh failed: ${e.message}\n`);
    }
  }, pollMs);
  const keepAlive = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

  function authorized(req, url) {
    if (!token) return true;
    const q = url.searchParams.get('token');
    const cookie = /(?:^|;\s*)aim_token=([^;]+)/.exec(req.headers.cookie || '');
    const given = q || (cookie && decodeURIComponent(cookie[1])) || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function send(res, code, type, body, extra = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
    if (!authorized(req, url)) return send(res, 401, 'text/plain', 'Unauthorized: open the dashboard with the full URL that `aim dashboard` printed (it has ?token=...).');
    const setCookie = token && url.searchParams.get('token')
      ? { 'Set-Cookie': `aim_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` } : {};

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE), setCookie);
    }
    if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(snap));
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(snap)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    const m = /^\/api\/artifacts\/([\w.-]+?)(\.md)?$/.exec(url.pathname);
    if (m) {
      const art = monitor.artifacts.get(m[1]);
      if (!art) return send(res, 404, 'application/json', '{"error":"not found"}');
      if (m[2]) return send(res, 200, 'text/markdown; charset=utf-8', art.markdown, { 'Content-Disposition': `attachment; filename="${m[1]}.md"` });
      return send(res, 200, 'application/json', JSON.stringify(art));
    }
    return send(res, 404, 'text/plain', 'Not found');
  });

  server.on('close', () => { clearInterval(timer); clearInterval(keepAlive); });
  return server;
}

module.exports = { createServer, lanAddresses };
