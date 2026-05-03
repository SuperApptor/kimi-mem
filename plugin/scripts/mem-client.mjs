#!/usr/bin/env node
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
        result = await request(`/api/search?${qs.toString()}`);
        break;
      }
      case 'timeline': {
        const qs = new URLSearchParams();
        if (params.anchor !== undefined) qs.append('anchor', String(params.anchor));
        if (params.query) qs.append('query', params.query);
        if (params.depth_before !== undefined) qs.append('depth_before', String(params.depth_before));
        if (params.depth_after !== undefined) qs.append('depth_after', String(params.depth_after));
        if (params.project) qs.append('project', params.project);
        result = await request(`/api/timeline?${qs.toString()}`);
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
        result = await request(`/api/context/inject?${qs.toString()}`);
        break;
      }
      case 'recent': {
        result = await request('/api/context/recent');
        break;
      }
      default:
        throw new Error(`Unknown endpoint: ${endpoint}`);
    }
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}
main();
