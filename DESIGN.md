# kimi-mem — Design Spec

## Goal
Bring persistent session memory to Kimi CLI by bridging its hook & plugin systems to the claude-mem worker engine.

## Architecture
```
Kimi CLI
├── Hooks (lifecycle events)
│   └── kimi-wrapper.mjs  →  HTTP API  →  claude-mem worker
└── Plugin (native tools)
    └── mem-client.mjs    →  HTTP API  →  claude-mem worker
```

## Components
1. **install.mjs** — Cross-platform installer (Windows / macOS / Linux)
2. **hooks/kimi-wrapper.mjs** — Translates Kimi hook JSON to claude-mem raw adapter format
3. **plugin/plugin.json** — Declares 5 native Kimi tools (search, timeline, get_observations, context, recent)
4. **plugin/scripts/mem-client.mjs** — HTTP client to claude-mem worker, reads port from settings

## License
- This repo: MIT (original scripts)
- Underlying engine: claude-mem by Alex Newman (AGPL-3.0)
