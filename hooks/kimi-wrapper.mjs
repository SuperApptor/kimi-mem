#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const event = process.argv[2];
if (!event) { process.stderr.write('Usage: node kimi-wrapper.mjs <event>\n'); process.exit(1); }

function getWorkerPort() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude-mem', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    return settings.CLAUDE_MEM_WORKER_PORT || '37778';
  } catch { return '37778'; }
}

function request(pathStr, method = 'GET', body = null) {
  const port = getWorkerPort();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: pathStr, method, headers: body ? { 'Content-Type': 'application/json' } : {}, timeout: 15000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ content: data }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', async () => {
  let payload = {};
  try { payload = JSON.parse(rawInput || '{}'); } catch { payload = {}; }

  const port = getWorkerPort();

  try {
    switch (event) {
      case 'SessionStart': {
        // context injection only
        const r = await request(`/api/context/inject?cwd=${encodeURIComponent(payload.cwd || process.cwd())}`, 'GET');
        if (r && typeof r === 'string' && r.trim()) {
          console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r } }));
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
        const r = await request('/api/sessions/observations', 'POST', body);
        // file-context is handled via the observation endpoint in claude-mem
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
        // no-op
        break;
      }
    }
    process.exit(0);
  } catch (err) {
    // Fail-open: never block Kimi
    process.exit(0);
  }
});
