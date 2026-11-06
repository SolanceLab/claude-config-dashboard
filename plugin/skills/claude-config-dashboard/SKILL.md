---
name: claude-config-dashboard
description: Use when the user wants to see everything in their Claude Code configuration at once (skills, agents, commands, workflows, MCP servers, hooks, plugins, settings, rules), or asks "what do I have installed?". Starts a local, read-only dashboard on their own computer and gives them the address to open.
---

# Claude Config Dashboard

A local, read-only page that lists the user's `~/.claude` folder: skills, agents, commands, workflows, MCP servers, hooks, scripts, plugins, marketplaces, settings and rules, with a live count for each and a reader for any item's source. It listens on `127.0.0.1` only, never changes the configuration, and shows key names, never secret values. It needs Node 18 or newer.

## Start it

Run this in the background, so the conversation can go on while it runs:

```
npx --yes "github:SolanceLab/claude-config-dashboard#v1.4.0"
```

When it prints `claude-config-dashboard → http://localhost:7373`, tell the user to open that address in their browser. The page re-scans every few seconds, so it is always current.

- If port 7373 is taken, start it again with `PORT=7400` in front of the command and give the user the new address.
- To show a different configuration folder, set `CLAUDE_DIR` to it.
- Anything beyond the plain view is off by default: extra panels (validator, sessions board, macOS launchd tab, status panels) are off until the user copies `dashboard.config.example.json` from the repository to `~/.claude/dashboard.config.json` and turns them on.

## Stop it

It keeps running until stopped. When the user is done, stop the background process you started (or press Ctrl+C in the terminal that runs it).

## What to say

Say the address, that it only reads and only listens on this computer, and that it is read-only. Do not paste its output into the chat: it lists the user's whole setup.
