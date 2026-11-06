// claude-config-dashboard — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0, see LICENSE.md. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const json = (p) => JSON.parse(read(p));
const version = read("CHANGELOG.md").match(/^## \[?(\d+\.\d+\.\d+)/m)[1];

test("both plugin manifests carry the room name and the changelog version", () => {
  for (const p of ["plugin/.claude-plugin/plugin.json", "plugin/.codex-plugin/plugin.json"]) {
    assert.equal(json(p).name, "claude-config-dashboard");
    assert.equal(json(p).version, version);
  }
  assert.equal(json("package.json").version, version);
});

test("the Codex manifest is skill-only", () => {
  const cx = json("plugin/.codex-plugin/plugin.json");
  assert.equal(cx.skills, "./skills/");
  assert.equal(cx.mcpServers, undefined);
});

test("the skill starts the release it ships with, and the server binds loopback", () => {
  const skill = read("plugin/skills/claude-config-dashboard/SKILL.md");
  assert.ok(skill.includes(`claude-config-dashboard#v${version}`));
  assert.ok(read("server.mjs").includes('server.listen(PORT, "127.0.0.1"'));
});
