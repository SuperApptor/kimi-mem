#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const event = process.argv[2];
if (!event) { process.stderr.write('Usage: node kimi-wrapper.mjs <event>\n'); process.exit(1); }

const PLATFORM = os.platform();
const IS_WIN = PLATFORM === 'win32';
const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.claude-mem', 'settings.json');
function getSocketPath() {
  if (!IS_WIN) return path.join(HOME, '.claude-mem', 'kimi-mem.sock');
  try {
    const pipeFile = path.join(HOME, '.claude-mem', 'pipe.name');
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf8').trim();
  } catch {}
  return `\\\\.\\pipe\\kimi-mem-v2`;
}
const SOCKET_PATH = getSocketPath();

/* ── Debug log (silent, never blocks Kimi) ───────────────────────────────── */
const DEBUG_LOG = path.join(HOME, '.kimi', 'hooks', 'claude-mem', 'wrapper-debug.log');
function debug(label, meta = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, label, ...meta }) + '\n';
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {}
}

/* ── Settings ────────────────────────────────────────────────────────────── */
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function getWorkerPort() {
  const s = readSettings();
  return s.CLAUDE_MEM_WORKER_PORT || '37780';
}

/* ── HTTP request with retry ─────────────────────────────────────────────── */
function request(targetPath, method = 'GET', body = null) {
  const doRequest = () => new Promise((resolve, reject) => {
    const opts = IS_WIN
      ? { socketPath: SOCKET_PATH, path: targetPath, method, headers: body ? { 'Content-Type': 'application/json' } : {}, timeout: 15000 }
      : { hostname: 'localhost', port: getWorkerPort(), path: targetPath, method, headers: body ? { 'Content-Type': 'application/json' } : {}, timeout: 15000 };

    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ content: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  return doRequest().catch(async (err) => {
    const retryable = err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.message?.includes('timeout');
    if (!retryable) throw err;
    debug('request_retry', { path: targetPath, error: err.message });
    await new Promise(r => setTimeout(r, 2000));
    return doRequest();
  });
}

/* ── Kill stale managers ─────────────────────────────────────────────────── */
function killStaleManagers() {
  if (!IS_WIN) return;
  try {
    const out = execSync('wmic process where "CommandLine like \'%worker-manager.mjs%\'" get ProcessId,CommandLine', { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const lines = out.split('\n').filter(l => l.includes('worker-manager.mjs'));
    for (const line of lines) {
      const m = line.match(/(\d+)\s*$/);
      if (m) {
        try { execSync(`taskkill /F /PID ${m[1]}`, { windowsHide: true, timeout: 3000 }); } catch {}
      }
    }
    debug('killed_stale_managers', { count: lines.length });
  } catch {
    // ignore errors (no stale managers)
  }
}

/* ── Ensure manager is running (Windows only) ────────────────────────────── */
async function ensureManagerRunning() {
  if (!IS_WIN) return;
  try {
    await request('/health', 'GET', null);
    return;
  } catch {
    debug('manager_not_responding');
  }

  killStaleManagers();
  await new Promise(r => setTimeout(r, 500));

  const managerPath = path.join(HOME, '.kimi', 'hooks', 'claude-mem', 'worker-manager.mjs');
  if (!fs.existsSync(managerPath)) {
    debug('manager_not_found', { path: managerPath });
    return;
  }

  try {
    const child = spawn(process.execPath, [managerPath, 'start'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    debug('manager_spawned', { pid: child.pid });

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { await request('/health', 'GET', null); return; }
      catch {}
    }
    debug('manager_never_ready');
  } catch (e) {
    debug('manager_spawn_error', { error: e.message });
  }
}

/* ── Main ────────────────────────────────────────────────────────────────── */
let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', async () => {
  let payload = {};
  try { payload = JSON.parse(rawInput || '{}'); } catch { payload = {}; }

  await ensureManagerRunning();

  try {
    switch (event) {
      case 'SessionStart': {
        const cwd = payload.cwd || process.cwd();
        const project = path.basename(cwd);
        const r = await request(`/api/context/inject?projects=${encodeURIComponent(project)}&cwd=${encodeURIComponent(cwd)}`, 'GET');
        let ctx = '';
        if (r) {
          if (typeof r === 'string') ctx = r;
          else if (r.content && typeof r.content === 'string') ctx = r.content;
          else if (r.error) ctx = '';
          else try { ctx = JSON.stringify(r); } catch { ctx = String(r); }
        }
        if (ctx && ctx.trim()) {
          console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
        }
        break;
      }
      case 'UserPromptSubmit': {
        const body = {
          contentSessionId: payload.session_id || 'unknown',
          project: payload.cwd ? path.basename(payload.cwd) : 'unknown',
          prompt: payload.prompt || '',
          platformSource: 'kimi'
        };
        await request('/api/sessions/init', 'POST', body);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const body = {
          contentSessionId: payload.session_id || 'unknown',
          platformSource: 'kimi',
          tool_name: payload.tool_name,
          tool_input: payload.tool_input,
          tool_response: payload.tool_output ?? (payload.error ? { error: payload.error } : undefined),
          cwd: payload.cwd || process.cwd(),
          agentId: payload.agent_id,
          agentType: payload.agent_type
        };
        await request('/api/sessions/observations', 'POST', body);
        break;
      }
      case 'PreToolUse': {
        const filePath = payload.tool_input?.path || payload.tool_input?.file_path;
        if (!filePath) break;
        const body = {
          contentSessionId: payload.session_id || 'unknown',
          platformSource: 'kimi',
          tool_name: payload.tool_name,
          tool_input: payload.tool_input,
          tool_response: { success: true },
          cwd: payload.cwd || process.cwd()
        };
        await request('/api/sessions/observations', 'POST', body);
        break;
      }
      case 'Stop': {
        const body = {
          contentSessionId: payload.session_id || 'unknown',
          last_assistant_message: '',
          platformSource: 'kimi'
        };
        await request('/api/sessions/summarize', 'POST', body);
        break;
      }
      case 'SessionEnd': {
        break;
      }
    }
    process.exit(0);
  } catch (err) {
    debug('hook_error', { error: err.message });
    process.exit(0);
  }
});
