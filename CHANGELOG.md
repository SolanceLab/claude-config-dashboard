# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.1.0] — 2026-06-25

### Added
- **Scripts** section — one menu listing every script your config actually runs (hook commands, MCP server entry files, status line, auth helpers), each click-to-read. Package-based MCP servers (`npx …`) are skipped — no local file.
- **Hooks** now show the body of the script they call, not just the command path.

_Same security model — read-only, loopback-only, secrets masked, opaque-id file reads._

## [1.0.0] — 2026-06-21

### Added
- Initial public release: a live, read-only dashboard of skills, agents, commands, workflows, MCP servers, hooks, plugins, marketplaces, settings, and rules in `~/.claude/`. Loopback-only, secrets masked, no dependencies, no telemetry.
