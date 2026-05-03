# Troubleshooting

## Worker won't start

```bash
# Check if port is already in use
lsof -i :37778        # macOS/Linux
netstat -ano | findstr :37778  # Windows

# Change port in ~/.claude-mem/settings.json
{
  "CLAUDE_MEM_WORKER_PORT": "37779"
}
```

## Chroma search timeout

On a fresh install, Chroma vector search may timeout and fall back to keyword search. This is normal — the vector index will sync automatically after a few observations.

## Hooks not firing

1. Verify hooks are registered: `/hooks` inside Kimi CLI
2. Check `~/.kimi/config.toml` contains the `[[hooks]]` entries
3. Restart Kimi CLI

## Plugin tools not appearing

```bash
kimi plugin list
```

If `claude-mem` is missing:
```bash
kimi plugin install ~/.kimi/plugins/claude-mem
```

## Switching language

Edit `~/.claude-mem/settings.json` and change `CLAUDE_MEM_MODE`:
- `"code"` — English
- `"code--fr"` — French
- `"code--es"` — Spanish

Then restart the worker.
