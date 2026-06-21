# claude-config-dashboard

A tiny **local, always-fresh dashboard** for everything in your `~/.claude/` — skills, agents, commands, workflows, MCP servers, hooks, plugins, marketplaces, settings, and rules — in one searchable view.

It runs a small Node server that **scans your filesystem live on every request**, so it can never go stale: there's no cached copy to drift, nothing to regenerate. Open it, and what you see is what's on disk right now.

> Read-only by design. It shows your config; it never changes it.

## Why

Claude Code's configuration sprawls across `~/.claude/` (skills, agents, commands, workflows, settings, hooks), the plugin cache, and `~/.claude.json` (MCP servers). There's no single place to see all of it. This is that place.

## Features

- **Sidebar navigation** — one section at a time, each with a live count: Skills · Agents · Commands · Workflows · MCP · Hooks · Plugins · Marketplaces · Settings · Rules.
- **Read the source** — click any skill, agent, command, workflow, plugin, or memory entry to read its full file in a modal; click a hook to see its full command.
- **Full settings surface** — every `settings.json` key, badged by safety tier (🟢 safe · 🟡 caution · 🔴 dangerous).
- **MCP servers** — names, transport, and env *key names* from `~/.claude.json`.
- **Live** — the page re-scans every few seconds; the dot pulses when fresh.
- **Filter** — instant search within the active section.

## Security model

This tool reads your config, some of which is sensitive. It's built to never expose it:

- **Loopback only.** Binds `127.0.0.1` — never `0.0.0.0`. Not reachable from your network.
- **Read-only.** No write endpoints. It cannot modify your Claude Code config.
- **Secrets masked.** Token/key/JWT/PEM shapes are redacted everywhere; environment variables and MCP server configs show **key names only**, never values; MCP `args`, URLs, and headers are never sent.
- **No raw paths on the wire.** File reads use opaque per-scan IDs mapped server-side to an allow-list, so the browser can't request an arbitrary path (no traversal).
- **No dependencies, no telemetry, no network calls** (other than loading fonts from Google Fonts — remove the `<link>` in `server.mjs` to go fully offline).

> Even so: this is a local developer tool. Run it on a machine you trust, for your own config.

## Install & run

Requires **Node 18+**. No install step, no dependencies.

```bash
# clone, then:
node server.mjs
# → http://localhost:7373
```

Or run it straight from GitHub without cloning:

```bash
npx github:SolanceLab/claude-config-dashboard
```

### Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `7373` | Port to listen on |
| `CLAUDE_DIR` | `~/.claude` | Point at a non-default config dir |
| `CLAUDE_MEMORY_DIR` | auto-discovered | Pin the memory dir (else the most recent `~/.claude/projects/*/memory/`) |

## Always-on (optional)

Keep it running so it's always a bookmark away.

**macOS (launchd)** — edit the paths in [`com.solancelab.claude-dashboard.plist`](./com.solancelab.claude-dashboard.plist), then:

```bash
cp com.solancelab.claude-dashboard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.solancelab.claude-dashboard.plist
```

**Linux (systemd user service)** — create `~/.config/systemd/user/claude-dashboard.service`:

```ini
[Unit]
Description=Claude Code config dashboard
[Service]
ExecStart=/usr/bin/node %h/path/to/claude-config-dashboard/server.mjs
Restart=always
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now claude-dashboard
```

**Windows (Task Scheduler)** — create a task that runs at logon:

```powershell
schtasks /create /tn "ClaudeConfigDashboard" /tr "node \"%USERPROFILE%\path\to\claude-config-dashboard\server.mjs\"" /sc onlogon /rl limited
```

(or just run `node server.mjs` in a terminal when you want it.) On Windows the dashboard reads `%USERPROFILE%\.claude` and `%USERPROFILE%\.claude.json` automatically.

## Platform support

Runs anywhere Node 18+ runs — **macOS, Linux, and Windows**. The server is pure Node with no OS-specific code; config paths resolve from your home directory automatically. Only the *always-on* setup differs per OS (launchd / systemd / Task Scheduler above) — the dashboard itself is identical.

## How it works

`server.mjs` is a single file with no dependencies. On each `GET /api/data` it walks `~/.claude/` and `~/.claude.json`, masks anything secret-shaped, and returns JSON; the page renders it and polls every 3s. `GET /api/doc?id=N` returns one allow-listed file's contents (masked). That's the whole thing.

## License

MIT — see [LICENSE](./LICENSE).

---

*Built by [SolanceLab](https://github.com/SolanceLab).*
