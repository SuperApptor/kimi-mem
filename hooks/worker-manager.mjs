#!/usr/bin/env node
/**
 * Kimi-Mem Pipe Bridge
 * --------------------
 * Lightweight persistent proxy that exposes the claude-mem worker
 * through a stable named-pipe (Windows) or Unix socket so wrappers
 * never deal with TCP port zombies.
 *
 * Usage:  node worker-manager.mjs start
 *         node worker-manager.mjs stop
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PLATFORM = os.platform();
const IS_WIN = PLATFORM === 'win32';
const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.claude-mem', 'settings.json');
const PID_FILE = path.join(HOME, '.claude-mem', 'worker.pid');
const USERNAME = process.env.USERNAME || 'user';
const PIPE_NAME = `\\\\.\\pipe\\kimi-mem-v2`;
const SOCK_PATH = path.join(HOME, '.claude-mem', `kimi-mem-${USERNAME}.sock`);
const ENDPOINT = IS_WIN ? PIPE_NAME : SOCK_PATH;

let currentWorkerPort = null;
let proxyServer = null;
let shuttingDown = false;

/* ── Utils ───────────────────────────────────────────────────────────────── */
function log(level, msg, meta = {}) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`, meta);
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); }
  catch { return null; }
}

function getWorkerPort() {
  const pid = readPidFile();
  if (pid && pid.port) return parseInt(pid.port, 10);
  const s = readSettings();
  return parseInt(s.CLAUDE_MEM_WORKER_PORT, 10) || 37780;
}

/* ── Proxy ───────────────────────────────────────────────────────────────── */
function startProxy() {
  proxyServer = http.createServer((clientReq, clientRes) => {
    const port = getWorkerPort();
    if (port !== currentWorkerPort) {
      currentWorkerPort = port;
      log('INFO', 'Worker port updated', { port });
    }

    const options = {
      hostname: 'localhost',
      port,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: `localhost:${port}` },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', (err) => {
      log('ERROR', 'Proxy request failed', { error: err.message, path: clientReq.url });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Worker unreachable', details: err.message }));
      }
    });

    clientReq.pipe(proxyReq, { end: true });
  });

  proxyServer.listen(ENDPOINT, () => {
    log('INFO', 'Pipe bridge listening', { endpoint: ENDPOINT, workerPort: getWorkerPort() });
  });

  proxyServer.on('error', (err) => {
    log('ERROR', 'Bridge server error', { error: err.message });
    if (!shuttingDown) process.exit(1);
  });

  return proxyServer;
}

function stopProxy() {
  shuttingDown = true;
  if (proxyServer) {
    proxyServer.close(() => log('INFO', 'Bridge closed'));
  }
  if (!IS_WIN) {
    try { fs.unlinkSync(SOCK_PATH); } catch {}
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const cmd = process.argv[2];
if (cmd === 'stop') {
  stopProxy();
  process.exit(0);
} else {
  startProxy();
  process.on('SIGTERM', () => { log('INFO', 'SIGTERM'); stopProxy(); process.exit(0); });
  process.on('SIGINT', () => { log('INFO', 'SIGINT'); stopProxy(); process.exit(0); });
}
