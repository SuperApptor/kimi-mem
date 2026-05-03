#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const event = process.argv[2];
if (!event) { process.stderr.write('Usage: node kimi-wrapper.mjs <event>\n'); process.exit(1); }

const HOME = os.homedir();
const PLATFORM = os.platform();
const BUN_PATH = process.env.BUN_PATH || path.join(HOME, '.bun', 'bin', PLATFORM === 'win32' ? 'bun.exe' : 'bun');
const WORKER_PATH = process.env.CLAUDE_MEM_WORKER_PATH || path.join(HOME, '.claude-mem-install', 'node_modules', 'claude-mem', 'plugin', 'scripts', 'worker-service.cjs');

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(rawInput || '{}'); } catch { payload = {}; }

  const mapped = {
    session_id: payload.session_id, cwd: payload.cwd, prompt: payload.prompt,
    tool_name: payload.tool_name, tool_input: payload.tool_input,
    tool_response: payload.tool_output ?? (payload.error ? { error: payload.error } : undefined),
    file_path: payload.file_path ?? payload.tool_input?.path ?? payload.tool_input?.file_path,
    metadata: {},
  };
  if (payload.source) mapped.metadata.source = payload.source;
  if (payload.reason) mapped.metadata.reason = payload.reason;
  if (payload.stop_hook_active !== undefined) mapped.metadata.stop_hook_active = payload.stop_hook_active;
  if (payload.hook_event_name) mapped.metadata.hook_event_name = payload.hook_event_name;
  if (payload.trigger) mapped.metadata.trigger = payload.trigger;
  if (payload.notification_type) mapped.metadata.notification_type = payload.notification_type;
  if (payload.agent_name) mapped.metadata.agent_name = payload.agent_name;

  const child = spawn(BUN_PATH, [WORKER_PATH, 'hook', 'raw', event], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.stdin.write(JSON.stringify(mapped));
  child.stdin.end();
  child.on('exit', code => { process.exit(code ?? 0); });
  child.on('error', err => { process.stderr.write(`Hook wrapper error: ${err.message}\n`); process.exit(0); });
});
