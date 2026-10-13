# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.2.0] — 2026-10-13

### Added
- **Optional config file** (`~/.claude/dashboard.config.json`, or `CONFIG_FILE`) for extra panels and branding. Without one, the dashboard looks and behaves exactly like 1.1.0.
- **Validator** — live checks: hook scripts that exist on disk, skill/agent/command frontmatter, files with a hardcoded home-folder path.
- **Sessions** — a claim board read from a folder of `*.claim` files (`key=value` lines); stale claims hide themselves.
- **Local tab (macOS)** — launchd jobs matching your prefixes: schedule, target health, loaded/running/exit code, and log freshness from a markdown table you keep. Opt-in; runs `plutil` and `launchctl print` read-only.
- **Cloud tab** — renders chosen `## N.` sections of a markdown infrastructure map, with optional tag lines (e.g. `HOT: api, web`).
- **Status panels** — show any small JSON status file (a health check's last result) with a pass/fail tag and its age.
- **Branding** — name, accent word, eyebrow, font and footer link.
- Tests (`npm test`) for the config loader and every parser.

_Same security model — read-only, loopback-only, secrets masked, opaque-id file reads. New panels send short names, never full paths._

## [1.1.0] — 2026-06-25

### Added
- **Scripts** section — one menu listing every script your config actually runs (hook commands, MCP server entry files, status line, auth helpers), each click-to-read. Package-based MCP servers (`npx …`) are skipped — no local file.
- **Hooks** now show the body of the script they call, not just the command path.

_Same security model — read-only, loopback-only, secrets masked, opaque-id file reads._

## [1.0.0] — 2026-06-21

### Added
- Initial public release: a live, read-only dashboard of skills, agents, commands, workflows, MCP servers, hooks, plugins, marketplaces, settings, and rules in `~/.claude/`. Loopback-only, secrets masked, no dependencies, no telemetry.
