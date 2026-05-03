#!/usr/bin/env node
/**
 * Kimi-Mem Worker Manager + Pipe Bridge
 * -------------------------------------
 * 1. Exposes the claude-mem worker through a stable named-pipe / Unix socket.
 * 2. Watches worker logs and auto-rotates the OpenRouter model on 404/429.
 * 3. Handles worker lifecycle (find free port, spawn, restart on model change).
 *
 * Usage:  node worker-manager.mjs start
 *         node worker-manager.mjs stop
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const PLATFORM = os.platform();
const IS_WIN = PLATFORM === 'win32';
const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.claude-mem', 'settings.json');
const PID_FILE = path.join(HOME, '.claude-mem', 'worker.pid');
const LOGS_DIR = path.join(HOME, '.claude-mem', 'logs');
const USERNAME = process.env.USERNAME || 'user';
const PIPE_NAME_FILE = path.join(HOME, '.claude-mem', 'pipe.name');
function generatePipeName() {
  const name = IS_WIN
    ? `\\\\.\\pipe\\kimi-mem-${USERNAME}-${Date.now()}`
    : path.join(HOME, '.claude-mem', `kimi-mem-${USERNAME}-${Date.now()}.sock`);
  try { fs.writeFileSync(PIPE_NAME_FILE, name, 'utf8'); } catch {}
  return name;
}
let ENDPOINT = generatePipeName();
const BUN_PATH = process.env.BUN_PATH || path.join(HOME, '.bun', 'bin', IS_WIN ? 'bun.exe' : 'bun');
const WORKER_SCRIPT = path.join(HOME, '.claude-mem-install', 'node_modules', 'claude-mem', 'plugin', 'scripts', 'worker-service.cjs');

function killStaleManagers() {
  if (!IS_WIN) return;
  try {
    const out = execSync('wmic process where "CommandLine like \'%worker-manager.mjs%\'" get ProcessId,CommandLine', { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const lines = out.split('\n').filter(l => l.includes('worker-manager.mjs') && !l.includes(String(process.pid)));
    for (const line of lines) {
      const m = line.match(/(\d+)\s*$/);
      if (m) {
        try { execSync(`taskkill /F /PID ${m[1]}`, { windowsHide: true, timeout: 3000 }); } catch {}
      }
    }
    log('INFO', 'Cleaned stale manager processes', { count: lines.length });
  } catch {}
}

const FALLBACK_MODELS = [
  'openrouter/owl-alpha',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'poolside/laguna-xs.2:free',
];

let currentWorkerPort = null;
let proxyServer = null;
let workerProcess = null;
let shuttingDown = false;
let currentModelIndex = 0;

/* ── Utils ───────────────────────────────────────────────────────────────── */
function log(level, msg, meta = {}) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`, meta);
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function writeSettings(obj) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', 'Failed to write settings', { error: e.message });
  }
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); }
  catch { return null; }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start = 37780, end = 37800) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

function getWorkerPort() {
  const pid = readPidFile();
  if (pid && pid.port) return parseInt(pid.port, 10);
  const s = readSettings();
  return parseInt(s.CLAUDE_MEM_WORKER_PORT, 10) || 37780;
}

function getCurrentModel() {
  const s = readSettings();
  return s.CLAUDE_MEM_OPENROUTER_MODEL || FALLBACK_MODELS[0];
}

function setNextModel() {
  const s = readSettings();
  const current = s.CLAUDE_MEM_OPENROUTER_MODEL || FALLBACK_MODELS[0];
  let idx = FALLBACK_MODELS.indexOf(current);
  if (idx === -1) idx = 0;
  idx = (idx + 1) % FALLBACK_MODELS.length;
  const next = FALLBACK_MODELS[idx];
  s.CLAUDE_MEM_OPENROUTER_MODEL = next;
  writeSettings(s);
  log('WARN', 'Rotated OpenRouter model', { from: current, to: next });
  return next;
}

async function httpRequest(targetPath, method = 'GET', body = null, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: currentWorkerPort ?? getWorkerPort(),
      path: targetPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* ── Worker lifecycle ────────────────────────────────────────────────────── */
async function startWorker() {
  if (workerProcess && !workerProcess.killed) {
    log('INFO', 'Worker already running', { pid: workerProcess.pid });
    return;
  }

  const settings = readSettings();
  let port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10) || 37780;

  if (!(await isPortFree(port))) {
    log('WARN', 'Configured port busy, scanning for free port', { port });
    port = await findFreePort();
    settings.CLAUDE_MEM_WORKER_PORT = String(port);
    writeSettings(settings);
    log('INFO', 'Updated settings with new port', { port });
  }

  currentWorkerPort = port;

  try { fs.unlinkSync(PID_FILE); } catch {}

  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) };
    const child = spawn(BUN_PATH, [WORKER_SCRIPT, 'start'], {
      env,
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    workerProcess = child;
    log('INFO', 'Worker spawned', { pid: child.pid, port });

    let errBuf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => {
      errBuf += d;
      if (errBuf.length > 5000) errBuf = errBuf.slice(-2500);
      watchOpenRouterErrors(d);
    });

    child.once('error', (err) => {
      log('ERROR', 'Worker spawn error', { error: err.message });
      reject(err);
    });

    child.on('exit', (code) => {
      log('WARN', 'Worker exited', { code });
      workerProcess = null;
    });

    // Wait for health
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const res = await httpRequest('/health', 'GET', null, 2000);
        if (res.status === 200) {
          clearInterval(check);
          log('INFO', 'Worker healthy', { port, pid: child.pid });
          resolve(child);
        }
      } catch {}
      if (attempts > 60) {
        clearInterval(check);
        reject(new Error('Worker did not become healthy after 60 attempts'));
      }
    }, 1000);
  });
}

function stopWorker() {
  if (workerProcess && !workerProcess.killed) {
    try {
      workerProcess.kill(IS_WIN ? 'SIGTERM' : 'SIGTERM');
    } catch {}
  }
}

/* ── OpenRouter model rotation ───────────────────────────────────────────── */
let openRouterErrorCount = 0;
let lastErrorTime = 0;
const ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 min
const ERROR_THRESHOLD = 3;

function watchOpenRouterErrors(chunk) {
  const text = String(chunk);
  const hasError = text.includes('OpenRouter API error: 404') || text.includes('OpenRouter API error: 429');
  if (!hasError) return;

  const now = Date.now();
  if (now - lastErrorTime > ERROR_WINDOW_MS) {
    openRouterErrorCount = 0;
  }
  openRouterErrorCount++;
  lastErrorTime = now;
  log('WARN', 'OpenRouter error detected', { count: openRouterErrorCount, windowMs: ERROR_WINDOW_MS });

  if (openRouterErrorCount >= ERROR_THRESHOLD) {
    openRouterErrorCount = 0;
    const next = setNextModel();
    log('INFO', 'Restarting worker with new model', { model: next });
    stopWorker();
    setTimeout(() => startWorker().catch(e => log('ERROR', 'Worker restart failed', { error: e.message })), 3000);
  }
}

/* ── Proxy server ────────────────────────────────────────────────────────── */
function startProxy() {
  proxyServer = http.createServer(async (clientReq, clientRes) => {
    const port = getWorkerPort();
    if (port !== currentWorkerPort) {
      currentWorkerPort = port;
      log('INFO', 'Worker port updated', { port });
    }

    // Ensure worker is alive
    try {
      await httpRequest('/health', 'GET', null, 3000);
    } catch {
      log('WARN', 'Worker unreachable, attempting restart...');
      try { await startWorker(); } catch (e) {
        clientRes.writeHead(503, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Worker unavailable', details: e.message }));
        return;
      }
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
    try { fs.unlinkSync(ENDPOINT); } catch {}
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const cmd = process.argv[2];

if (cmd === 'stop') {
  stopWorker();
  stopProxy();
  process.exit(0);
} else {
  killStaleManagers();
  startWorker()
    .then(() => startProxy())
    .catch((err) => {
      log('FATAL', 'Startup failed', { error: err.message });
      process.exit(1);
    });

  process.on('SIGTERM', () => { log('INFO', 'SIGTERM'); stopWorker(); stopProxy(); process.exit(0); });
  process.on('SIGINT', () => { log('INFO', 'SIGINT'); stopWorker(); stopProxy(); process.exit(0); });
}
