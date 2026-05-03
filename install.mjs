#!/usr/bin/env node
/**
 * Cross-platform installer: Claude-mem for Kimi CLI
 * Supports: Windows, macOS, Linux
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PLATFORM = os.platform();
const HOME = os.homedir();
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';

const C = {
  g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', reset: '\x1b[0m'
};
const ok = (m) => console.log(`${C.g}✓${C.reset} ${m}`);
const warn = (m) => console.log(`${C.y}⚠${C.reset} ${m}`);
const fail = (m) => console.error(`${C.r}✗${C.reset} ${m}`);
const info = (m) => console.log(`${C.b}→${C.reset} ${m}`);

const PATHS = {
  bun: IS_WIN ? path.join(HOME, '.bun', 'bin', 'bun.exe') : path.join(HOME, '.bun', 'bin', 'bun'),
  claudeMemInstall: path.join(HOME, '.claude-mem-install'),
  claudeMemData: path.join(HOME, '.claude-mem'),
  claudeMemSettings: path.join(HOME, '.claude-mem', 'settings.json'),
  kimiConfig: path.join(HOME, '.kimi', 'config.toml'),
  kimiHooksDir: path.join(HOME, '.kimi', 'hooks', 'claude-mem'),
  kimiPluginsDir: path.join(HOME, '.kimi', 'plugins', 'claude-mem'),
  kimiPluginsScriptsDir: path.join(HOME, '.kimi', 'plugins', 'claude-mem', 'scripts'),
};

function exec(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: IS_WIN, ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    child.on('error', reject);
  });
}

function execOut(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { shell: IS_WIN, ...opts });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `Exit ${code}`))));
    child.on('error', reject);
  });
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

async function checkNode() {
  info('Checking Node.js...');
  const v = process.version;
  const major = parseInt(v.slice(1));
  if (major < 20) throw new Error(`Node.js >= 20 required, found ${v}`);
  ok(`Node.js ${v}`);
}

async function checkBun() {
  info('Checking Bun...');
  if (fs.existsSync(PATHS.bun)) {
    const v = await execOut(PATHS.bun, ['--version']).catch(() => '');
    if (v) { ok(`Bun ${v}`); return; }
  }
  warn('Bun not found, installing...');
  if (IS_WIN) {
    await exec('powershell', ['-Command', 'irm bun.sh/install.ps1 | iex']);
  } else {
    await exec('bash', ['-c', 'curl -fsSL https://bun.sh/install | bash']);
  }
  ok('Bun installed');
}

async function installClaudeMem() {
  info('Installing claude-mem...');
  ensureDir(PATHS.claudeMemInstall);
  if (!fs.existsSync(path.join(PATHS.claudeMemInstall, 'node_modules', 'claude-mem'))) {
    await exec('npm', ['install', 'claude-mem', '--omit=optional'], { cwd: PATHS.claudeMemInstall });
  }
  ok('claude-mem installed');
}

async function configureSettings() {
  info('Configuring claude-mem settings...');
  ensureDir(PATHS.claudeMemData);
  let settings = {};
  if (fs.existsSync(PATHS.claudeMemSettings)) {
    settings = JSON.parse(fs.readFileSync(PATHS.claudeMemSettings, 'utf8'));
  }
  settings.CLAUDE_MEM_MODE = settings.CLAUDE_MEM_MODE || 'code--fr';
  settings.CLAUDE_MEM_WORKER_PORT = settings.CLAUDE_MEM_WORKER_PORT || '37778';
  settings.CLAUDE_MEM_WORKER_HOST = settings.CLAUDE_MEM_WORKER_HOST || '127.0.0.1';
  fs.writeFileSync(PATHS.claudeMemSettings, JSON.stringify(settings, null, 2));
  ok('Settings written');
}

function wrapperContent() {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const event = process.argv[2];
if (!event) { process.stderr.write('Usage: node kimi-wrapper.mjs <event>\\n'); process.exit(1); }

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
  child.on('error', err => { process.stderr.write(\`Hook wrapper error: \${err.message}\\n\`); process.exit(0); });
});
`;
}

function pluginJsonContent() {
  return JSON.stringify({
    name: 'claude-mem', version: '1.0.0',
    description: 'Native Kimi plugin for Claude-mem persistent memory search and context injection',
    tools: [
      { name: 'mem_search', description: 'Step 1: Search memory index with IDs. Returns compact results (~50-100 tokens each). ALWAYS use FIRST before fetching details.', command: ['node', 'scripts/mem-client.mjs', 'search'], parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, project: { type: 'string' }, type: { type: 'string' }, obs_type: { type: 'string' }, dateStart: { type: 'string' }, dateEnd: { type: 'string' }, offset: { type: 'number' }, orderBy: { type: 'string' } }, required: ['query'] } },
      { name: 'mem_timeline', description: 'Step 2: Get chronological context around an observation ID or query. Use AFTER mem_search.', command: ['node', 'scripts/mem-client.mjs', 'timeline'], parameters: { type: 'object', properties: { anchor: { type: 'number' }, query: { type: 'string' }, depth_before: { type: 'number' }, depth_after: { type: 'number' }, project: { type: 'string' } } } },
      { name: 'mem_get_observations', description: 'Step 3: Fetch full details for specific observation IDs. Use LAST after filtering with mem_search.', command: ['node', 'scripts/mem-client.mjs', 'get_observations'], parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] } },
      { name: 'mem_context', description: 'Inject relevant memory context for the current project/session.', command: ['node', 'scripts/mem-client.mjs', 'context_inject'], parameters: { type: 'object', properties: { projects: { type: 'string' }, cwd: { type: 'string' } } } },
      { name: 'mem_recent', description: 'Get recent memory context without searching.', command: ['node', 'scripts/mem-client.mjs', 'recent'], parameters: { type: 'object', properties: {} } }
    ]
  }, null, 2);
}

function memClientContent() {
  return `#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function getWorkerPort() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude-mem', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    return settings.CLAUDE_MEM_WORKER_PORT || '37778';
  } catch { return '37778'; }
}

const endpoint = process.argv[2];
if (!endpoint) { console.error(JSON.stringify({ error: 'Usage: node mem-client.mjs <endpoint>' })); process.exit(1); }

let params = {};
try {
  const stdin = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
  if (stdin.trim()) params = JSON.parse(stdin);
} catch { /* ignore */ }

function request(pathStr, method = 'GET', body = null) {
  const port = getWorkerPort();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: pathStr, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ content: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  try {
    let result;
    switch (endpoint) {
      case 'search': {
        const qs = new URLSearchParams();
        if (params.query) qs.append('query', params.query);
        if (params.limit !== undefined) qs.append('limit', String(params.limit));
        if (params.project) qs.append('project', params.project);
        if (params.type) qs.append('type', params.type);
        if (params.obs_type) qs.append('obs_type', params.obs_type);
        if (params.dateStart) qs.append('dateStart', params.dateStart);
        if (params.dateEnd) qs.append('dateEnd', params.dateEnd);
        if (params.offset !== undefined) qs.append('offset', String(params.offset));
        if (params.orderBy) qs.append('orderBy', params.orderBy);
        result = await request(\`/api/search?\${qs.toString()}\`);
        break;
      }
      case 'timeline': {
        const qs = new URLSearchParams();
        if (params.anchor !== undefined) qs.append('anchor', String(params.anchor));
        if (params.query) qs.append('query', params.query);
        if (params.depth_before !== undefined) qs.append('depth_before', String(params.depth_before));
        if (params.depth_after !== undefined) qs.append('depth_after', String(params.depth_after));
        if (params.project) qs.append('project', params.project);
        result = await request(\`/api/timeline?\${qs.toString()}\`);
        break;
      }
      case 'get_observations': {
        result = await request('/api/observations/batch', 'POST', { ids: Array.isArray(params.ids) ? params.ids : [] });
        break;
      }
      case 'context_inject': {
        const qs = new URLSearchParams();
        if (params.projects) qs.append('projects', params.projects);
        if (params.cwd) qs.append('cwd', params.cwd);
        result = await request(\`/api/context/inject?\${qs.toString()}\`);
        break;
      }
      case 'recent': {
        result = await request('/api/context/recent');
        break;
      }
      default:
        throw new Error(\`Unknown endpoint: \${endpoint}\`);
    }
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}
main();
`;
}

async function createFiles() {
  info('Creating hook wrapper...');
  ensureDir(PATHS.kimiHooksDir);
  writeFile(path.join(PATHS.kimiHooksDir, 'kimi-wrapper.mjs'), wrapperContent());
  ok('Hook wrapper created');

  info('Creating plugin...');
  ensureDir(PATHS.kimiPluginsScriptsDir);
  writeFile(path.join(PATHS.kimiPluginsDir, 'plugin.json'), pluginJsonContent());
  writeFile(path.join(PATHS.kimiPluginsScriptsDir, 'mem-client.mjs'), memClientContent());
  ok('Plugin created');
}

async function updateKimiConfig() {
  info('Updating ~/.kimi/config.toml...');
  const configPath = PATHS.kimiConfig;
  if (!fs.existsSync(configPath)) {
    warn('~/.kimi/config.toml not found, skipping hooks config');
    return;
  }
  let toml = fs.readFileSync(configPath, 'utf8');

  const wrapperPath = path.join(PATHS.kimiHooksDir, 'kimi-wrapper.mjs');
  const wrapperCmd = IS_WIN ? wrapperPath.replace(/\\/g, '\\\\') : wrapperPath;

  const hookBlock = `[[hooks]]
event = "SessionStart"
command = "node ${wrapperCmd} SessionStart"
timeout = 10

[[hooks]]
event = "UserPromptSubmit"
command = "node ${wrapperCmd} UserPromptSubmit"
timeout = 10

[[hooks]]
event = "PostToolUse"
command = "node ${wrapperCmd} PostToolUse"
timeout = 10

[[hooks]]
event = "PostToolUseFailure"
command = "node ${wrapperCmd} PostToolUse"
timeout = 10

[[hooks]]
event = "PreToolUse"
matcher = "ReadFile"
command = "node ${wrapperCmd} PreToolUse"
timeout = 10

[[hooks]]
event = "Stop"
command = "node ${wrapperCmd} Stop"
timeout = 45

[[hooks]]
event = "SessionEnd"
command = "node ${wrapperCmd} SessionEnd"
timeout = 10`;

  if (toml.includes('event = "SessionStart"') && toml.includes('claude-mem')) {
    // Replace existing block
    const regex = /\[\[hooks\]\]\nevent = "SessionStart"[\s\S]*?\[\[hooks\]\]\nevent = "SessionEnd".*?timeout = \d+/;
    toml = toml.replace(regex, hookBlock);
    ok('Existing hooks updated');
  } else if (toml.includes('hooks = []')) {
    toml = toml.replace('hooks = []', hookBlock);
    ok('Hooks added');
  } else {
    toml += '\n' + hookBlock + '\n';
    ok('Hooks appended');
  }

  fs.writeFileSync(configPath, toml, 'utf8');
}

async function setupAutoStart() {
  info('Setting up auto-start...');
  if (IS_WIN) {
    const ps = `
$action = New-ScheduledTaskAction -Execute '${PATHS.bun.replace(/'/g, "''")}' -Argument '${path.join(PATHS.claudeMemInstall, 'node_modules', 'claude-mem', 'plugin', 'scripts', 'worker-service.cjs').replace(/'/g, "''")} start'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName 'Claude-Mem Worker' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
`;
    const tmp = path.join(os.tmpdir(), 'claude-mem-task.ps1');
    fs.writeFileSync(tmp, ps, 'utf8');
    await exec('powershell', ['-ExecutionPolicy', 'Bypass', '-File', tmp]);
    fs.unlinkSync(tmp);
    ok('Windows scheduled task created');
  } else if (IS_MAC) {
    const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'ai.claude-mem.worker.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.claude-mem.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PATHS.bun}</string>
    <string>${path.join(PATHS.claudeMemInstall, 'node_modules', 'claude-mem', 'plugin', 'scripts', 'worker-service.cjs')}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(PATHS.claudeMemData, 'logs', 'launchd.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(PATHS.claudeMemData, 'logs', 'launchd.err.log')}</string>
</dict>
</plist>`;
    ensureDir(path.dirname(plistPath));
    writeFile(plistPath, plist);
    await exec('launchctl', ['load', plistPath]);
    ok('macOS LaunchAgent created');
  } else {
    warn('Auto-start not configured for this OS. Please set up a systemd service or cron job manually.');
  }
}

async function installKimiPlugin() {
  info('Installing Kimi plugin...');
  const kimiBin = await execOut(IS_WIN ? 'where' : 'which', ['kimi']).catch(() => '');
  const kimiPath = kimiBin.split(/\r?\n/)[0].trim();
  if (kimiPath) {
    await exec(kimiPath, ['plugin', 'install', PATHS.kimiPluginsDir]);
    ok('Plugin installed');
  } else {
    warn('kimi CLI not found in PATH. Install manually with: kimi plugin install ~/.kimi/plugins/claude-mem');
  }
}

async function startWorker() {
  info('Starting worker...');
  await exec(PATHS.bun, [path.join(PATHS.claudeMemInstall, 'node_modules', 'claude-mem', 'plugin', 'scripts', 'worker-service.cjs'), 'start']);
  ok('Worker started');
}

async function main() {
  console.log(`${C.b}=== Claude-mem for Kimi CLI — Cross-platform Installer ===${C.reset}\n`);
  try {
    await checkNode();
    await checkBun();
    await installClaudeMem();
    await configureSettings();
    await createFiles();
    await updateKimiConfig();
    await setupAutoStart();
    await installKimiPlugin();
    await startWorker();
    console.log(`\n${C.g}✓ Done!${C.reset} Restart Kimi CLI to activate hooks & plugin.`);
    console.log(`${C.b}  Viewer:${C.reset} http://localhost:37778`);
  } catch (e) {
    fail(e.message);
    process.exit(1);
  }
}

main();
