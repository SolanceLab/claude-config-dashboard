---
name: config-dashboard
description: Use when the user wants to see what is in their Claude Code configuration; Claude Config Dashboard is a local, read-only page that lists it.
---

# Claude Config Dashboard

A local, read-only dashboard of the user's ~/.claude folder: skills, agents, commands, workflows, MCP servers, hooks, scripts, plugins, settings and rules. It runs on the user's own computer (node server.mjs) and listens on 127.0.0.1 only.

Limits: it never changes the configuration, shows secret values never (key names only), and needs Node 18 or newer.
