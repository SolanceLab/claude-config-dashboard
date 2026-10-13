// claude-config-dashboard — Copyright (c) 2026 SolanceLab (House of Solance). MIT License, see LICENSE. Required Notice: Copyright (c) 2026 SolanceLab (House of Solance) (https://github.com/SolanceLab)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPath, scanStatusPanel, parseClaim, scanPanels, uiConfig, parseLaunchctlPrint,
  scanClaims, scanInfraMap, loadConfig, parseLogTable, parseInfraMap,
  normalizeConfig, scheduleOf, scanLaunchd,
} from "../lib/panels.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccd-test-"));
const HOME = "/home/someone";

// ---------- config ----------
test("no config = v1.1.0 behaviour: every optional panel off, no extra sections or tabs", () => {
  const c = normalizeConfig(undefined, { platform: "darwin", home: HOME });
  assert.equal(c.validator.enabled, false);
  assert.equal(c.sessions.enabled, false);
  assert.equal(c.launchd.enabled, false);
  assert.equal(c.infraMap.enabled, false);
  assert.deepEqual(c.statusPanels, []);
  assert.equal(c.brand.name, "Config");
  assert.equal(c.brand.eyebrow, "Claude Code");
  const ui = uiConfig(c, scanPanels(c));
  assert.deepEqual(ui.sections, []);
  assert.deepEqual(ui.tabs, [{ id: "code", label: "Claude Code" }]);
});

test("loadConfig: missing file → defaults; bad JSON → defaults + error", () => {
  const d = tmp();
  const none = loadConfig({ env: { CONFIG_FILE: join(d, "nope.json") }, platform: "darwin", home: HOME });
  assert.equal(none.file, null);
  assert.equal(none.error, null);
  assert.equal(none.config.validator.enabled, false);
  writeFileSync(join(d, "bad.json"), "{not json");
  const bad = loadConfig({ env: { CONFIG_FILE: join(d, "bad.json") }, platform: "darwin", home: HOME });
  assert.match(bad.error, /not valid JSON/);
  assert.equal(bad.config.sessions.enabled, false);
  rmSync(d, { recursive: true });
});

test("loadConfig: default location is <claudeDir>/dashboard.config.json; env overrides apply", () => {
  const d = tmp();
  writeFileSync(join(d, "dashboard.config.json"), JSON.stringify({ validator: { enabled: true } }));
  const r = loadConfig({ env: { WORKSPACE_DIR: "/ws", CLAIMS_DIR: "/ws/claims" }, claudeDir: d, platform: "linux", home: HOME });
  assert.equal(r.config.validator.enabled, true);
  assert.equal(r.config.workspaceDir, "/ws");
  assert.equal(r.config.sessions.enabled, true);
  assert.equal(r.config.sessions.dir, "/ws/claims");
  rmSync(d, { recursive: true });
});

test("config paths: ~ expands, relative paths resolve against workspaceDir, relative without workspace drops", () => {
  const c = normalizeConfig({
    workspaceDir: "~/work",
    sessions: { enabled: true, dir: ".claims" },
    infraMap: { enabled: true, file: "/abs/MAP.md" },
    statusPanels: [{ label: "A", file: "state/a.json" }, { label: "B" }],
  }, { platform: "darwin", home: HOME });
  assert.equal(c.workspaceDir, "/home/someone/work");
  assert.equal(c.sessions.dir, "/home/someone/work/.claims");
  assert.equal(c.infraMap.file, "/abs/MAP.md");
  assert.equal(c.statusPanels.length, 1, "a panel with no file is dropped");
  assert.equal(c.statusPanels[0].file, "/home/someone/work/state/a.json");
  const noWs = normalizeConfig({ sessions: { enabled: true, dir: "rel" } }, { home: HOME });
  assert.equal(noWs.sessions.dir, null);
});

test("launchd is forced off outside macOS, and needs an explicit opt-in", () => {
  assert.equal(normalizeConfig({ launchd: { enabled: true, prefixes: ["com.x."] } }, { platform: "linux" }).launchd.enabled, false);
  assert.equal(normalizeConfig({ launchd: { enabled: true, prefixes: ["com.x."] } }, { platform: "darwin" }).launchd.enabled, true);
  assert.equal(normalizeConfig({ launchd: { prefixes: ["com.x."] } }, { platform: "darwin" }).launchd.enabled, false);
});

test("brand: footer URL must be http(s); font name is sanitised", () => {
  const c = normalizeConfig({ brand: { footerUrl: "javascript:alert(1)", font: 'Evil"};x{' } });
  assert.equal(c.brand.footerUrl, "https://github.com/SolanceLab");
  assert.equal(c.brand.font, "Evilx");
  assert.equal(normalizeConfig({ brand: { font: "Söhne" } }).brand.font, "Söhne");
});

// ---------- sessions ----------
test("parseClaim ignores prototype keys and junk lines", () => {
  const kv = parseClaim("session=abc\n__proto__=x\nconstructor=y\nPurpose=no\npurpose=fix it\n");
  assert.equal(kv.session, "abc");
  assert.equal(kv.purpose, "fix it");
  assert.equal(Object.prototype.hasOwnProperty.call(kv, "__proto__"), false);
  assert.equal(kv.Purpose, undefined);
});

test("scanClaims: lists fresh claims sorted, hides stale ones, null when dir missing or disabled", () => {
  const d = tmp();
  writeFileSync(join(d, "zeta.claim"), "session=s1\nsince=today\npurpose=work\n");
  writeFileSync(join(d, "alpha.claim"), "session=s2\n");
  writeFileSync(join(d, "old.claim"), "session=s3\n");
  writeFileSync(join(d, "notes.txt"), "ignored");
  const old = (Date.now() - 7 * 3600 * 1000) / 1000;
  utimesSync(join(d, "old.claim"), old, old);
  const cfg = { enabled: true, dir: d, staleHours: 6 };
  const out = scanClaims(cfg);
  assert.deepEqual(out.map((x) => x.repo), ["alpha", "zeta"]);
  assert.deepEqual(out[1], { repo: "zeta", session: "s1", since: "today", purpose: "work" });
  assert.equal(out[0].session, "s2");
  assert.equal(scanClaims({ ...cfg, dir: join(d, "missing") }), null);
  assert.equal(scanClaims({ ...cfg, enabled: false }), null);
  rmSync(d, { recursive: true });
});

// ---------- launchd ----------
test("scheduleOf covers calendar, interval, keepalive and run-at-load", () => {
  assert.equal(scheduleOf({ StartCalendarInterval: { Hour: 2, Minute: 5 } }), "daily 02:05");
  assert.equal(scheduleOf({ StartCalendarInterval: [{ Weekday: 1, Hour: 9, Minute: 0 }, { Hour: 21 }] }), "Mon 09:00 · daily 21:00");
  assert.equal(scheduleOf({ StartInterval: 1800 }), "every 30m");
  assert.equal(scheduleOf({ StartInterval: 7200 }), "every 2h");
  assert.equal(scheduleOf({ StartInterval: 45 }), "every 45s");
  assert.equal(scheduleOf({ KeepAlive: true }), "KeepAlive");
  assert.equal(scheduleOf({ KeepAlive: { SuccessfulExit: false } }), "KeepAlive on fail");
  assert.equal(scheduleOf({ KeepAlive: { NetworkState: true } }), "KeepAlive (conditional)");
  assert.equal(scheduleOf({}), "RunAtLoad only");
});

test("parseLaunchctlPrint reads state, pid and last exit; null = not loaded", () => {
  const out = "gui/501/com.x.job = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}";
  assert.deepEqual(parseLaunchctlPrint(out), { loaded: true, state: "running", running: true, pid: "4242", lastExit: "0" });
  assert.deepEqual(parseLaunchctlPrint("\tstate = not running\n\tlast exit code = -9\n"), { loaded: true, state: "not running", running: false, pid: null, lastExit: "-9" });
  assert.equal(parseLaunchctlPrint(null).loaded, false);
});

test("parseLogTable: section pick, ~ / relative / brace paths, notes, dashes, header + rule rows skipped", () => {
  const d = tmp();
  mkdirSync(join(d, "sub", "logs"), { recursive: true });
  writeFileSync(join(d, "a.log"), "x");
  writeFileSync(join(d, "sub", "logs", "d.log"), "old");
  writeFileSync(join(d, "sub", "logs", "d.err"), "new");
  const past = (Date.now() - 3600 * 1000) / 1000;
  utimesSync(join(d, "sub", "logs", "d.log"), past, past);
  const md = [
    "# Map", "", "## 1. Jobs", "",
    "| Job | Schedule | Target | Log | Expected |",
    "|---|---|---|---|---|",
    "| com.x.a | daily | a.sh | a.log (the real one) | ok |",
    "| com.x.b | — | b.sh | — | none |",
    "| com.x.c | KeepAlive | c | ~/c.log | ok |",
    "| com.x.d | KeepAlive | d | logs/d.{log,err} | ok |",
    "", "## 2. Other", "| Job | x | y | z |", "|---|---|---|---|", "| com.x.other | a | b | other.log |",
  ].join("\n");
  const m = parseLogTable(md, { section: "1.", searchDirs: [d, join(d, "sub")], home: "/h" });
  assert.deepEqual(m.get("com.x.a"), { logPath: join(d, "a.log"), note: "the real one" });
  assert.deepEqual(m.get("com.x.b"), { logPath: null, note: "" });
  assert.equal(m.get("com.x.c").logPath, "/h/c.log");
  assert.equal(m.get("com.x.d").logPath, join(d, "sub", "logs", "d.err"), "newest brace candidate wins");
  assert.equal(m.has("Job"), false);
  assert.equal(m.has("com.x.other"), false, "rows outside the chosen section are ignored");
  assert.equal(parseLogTable("", { section: "1." }).size, 0);
  rmSync(d, { recursive: true });
});

test("scanLaunchd: filters by prefix, reports target health + log colour, never sends full paths", () => {
  const home = tmp();
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const script = join(home, "run.sh");
  writeFileSync(script, "#!/bin/sh\n");
  chmodSync(script, 0o755);
  const noexec = join(home, "noexec.sh");
  writeFileSync(noexec, "#!/bin/sh\n");
  chmodSync(noexec, 0o644);
  writeFileSync(join(home, "fresh.log"), "x");
  const plists = {
    "com.mine.fresh.plist": { Label: "com.mine.fresh", ProgramArguments: ["/bin/sh", script], StartInterval: 600 },
    "com.mine.gone.plist": { Label: "com.mine.gone", ProgramArguments: ["/bin/sh", join(home, "gone.sh")], KeepAlive: true },
    "com.mine.direct.plist": { Label: "com.mine.direct", ProgramArguments: [noexec] },
    "com.mine.bad.plist": { Label: "bad label; rm -rf", ProgramArguments: ["/bin/true"] },
    "org.other.plist": { Label: "org.other", ProgramArguments: ["/bin/true"] },
  };
  for (const f of Object.keys(plists)) writeFileSync(join(agents, f), "");
  writeFileSync(join(home, "MAP.md"), "## 1. Jobs\n| Job | s | t | Log |\n|---|---|---|---|\n| com.mine.fresh | x | y | fresh.log |\n");
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "plutil") return JSON.stringify(plists[args[4].split("/").pop()]);
    if (cmd === "launchctl") return args[1].endsWith("com.mine.fresh") ? "state = running\npid = 7\n" : args[1].endsWith("com.mine.gone") ? null : "state = not running\nlast exit code = 1\n";
    return null;
  };
  const cfg = normalizeConfig({
    workspaceDir: home,
    launchd: { enabled: true, prefixes: ["com.mine."], logTable: { file: "MAP.md", section: "1.", logColumn: 4 } },
  }, { platform: "darwin", home });
  const r = scanLaunchd(cfg.launchd, { run, home, uid: 501 });
  assert.deepEqual(r.jobs.map((j) => j.label), ["com.mine.direct", "com.mine.fresh", "com.mine.gone"]);
  const [direct, fresh, gone] = r.jobs;
  assert.equal(fresh.running, true);
  assert.equal(fresh.pid, "7");
  assert.equal(fresh.schedule, "every 10m");
  assert.equal(fresh.targetBase, "run.sh");
  assert.equal(fresh.logColor, "green");
  assert.equal(fresh.logTail.endsWith("fresh.log"), true);
  assert.equal(gone.targetExists, false);
  assert.equal(gone.loaded, false);
  assert.equal(gone.logColor, "red");
  assert.equal(direct.execBitOk, false, "a directly-run target needs its exec bit");
  assert.equal(direct.lastExit, "1");
  assert.ok(calls.every(([cmd]) => cmd === "plutil" || cmd === "launchctl"));
  assert.ok(calls.some(([cmd, a, b]) => cmd === "launchctl" && a === "print" && b === "gui/501/com.mine.fresh"));
  assert.equal(calls.some((c) => c.join(" ").includes("bad label")), false, "unsafe labels never reach launchctl");
  const wire = JSON.stringify(r);
  assert.equal(wire.includes(home), false, "no full paths in the payload");
  assert.equal(scanLaunchd({ ...cfg.launchd, enabled: false }, { run, home }), null);
  rmSync(home, { recursive: true });
});

test("scanLaunchd without a log table: log colour is 'none'", () => {
  const home = tmp();
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.a.plist"), "");
  const run = (cmd) => (cmd === "plutil" ? JSON.stringify({ Label: "com.a", ProgramArguments: ["/bin/true"] }) : null);
  const cfg = normalizeConfig({ launchd: { enabled: true, prefixes: ["com.a"] } }, { platform: "darwin", home });
  const r = scanLaunchd(cfg.launchd, { run, home });
  assert.equal(r.hasLogTable, false);
  assert.equal(r.jobs[0].logColor, "none");
  rmSync(home, { recursive: true });
});

// ---------- infra map ----------
const MAP = [
  "# Infra", "intro", "",
  "## 1. Local", "local stuff",
  "## 3. Cloud", "*Verified 2026-01-01*", "HOT (daily): api (main), **web**.", "WARM: docs", "body line",
  "## 4. Database", "two projects",
  "## Rules", "not numbered",
].join("\n");

test("parseInfraMap: numbered sections, optional filter, stamp lifted out, tag lines parsed", () => {
  const all = parseInfraMap(MAP, { tagKeys: ["HOT", "WARM", "DORMANT"] });
  assert.deepEqual(all.sections.map((s) => s.title), ["1. Local", "3. Cloud", "4. Database"]);
  const only = parseInfraMap(MAP, { sections: ["3", "4"], tagKeys: ["HOT", "WARM", "DORMANT"] });
  assert.deepEqual(only.sections.map((s) => s.num), ["3", "4"]);
  const cloud = only.sections[0];
  assert.equal(cloud.stamp, "Verified 2026-01-01");
  assert.equal(cloud.body.includes("Verified"), false);
  assert.deepEqual(cloud.tags.HOT, [{ name: "api", hint: "main" }, { name: "web", hint: "" }]);
  assert.deepEqual(cloud.tags.WARM, [{ name: "docs", hint: "" }]);
  assert.deepEqual(cloud.tags.DORMANT, []);
  assert.equal(only.sections[1].tags, null, "no tag lines → no tag block");
  assert.equal(parseInfraMap(null).missing, true);
});

test("scanInfraMap hides the tab (null) when the file is absent or disabled", () => {
  const d = tmp();
  assert.equal(scanInfraMap({ enabled: true, file: join(d, "none.md"), sections: null, tagKeys: [] }), null);
  writeFileSync(join(d, "m.md"), MAP);
  assert.equal(scanInfraMap({ enabled: true, file: join(d, "m.md"), sections: ["4"], tagKeys: [] }).sections.length, 1);
  assert.equal(scanInfraMap({ enabled: false, file: join(d, "m.md") }), null);
  rmSync(d, { recursive: true });
});

// ---------- status panels ----------
test("getPath walks dotted keys and refuses prototype keys", () => {
  assert.equal(getPath({ a: { b: 2 } }, "a.b"), 2);
  assert.equal(getPath({ a: 1 }, "a.b"), undefined);
  assert.equal(getPath({}, "__proto__.x"), undefined);
});

test("scanStatusPanel: missing file hidden; invalid JSON flagged; ok / fail / info levels; age", () => {
  const d = tmp();
  const base = { id: "status-0", statusKey: "last.status", timeKey: "last.at", failValues: ["fail"], okValues: ["pass"] };
  assert.equal(scanStatusPanel({ ...base, file: join(d, "none.json") }), null);
  writeFileSync(join(d, "bad.json"), "{");
  assert.equal(scanStatusPanel({ ...base, file: join(d, "bad.json") }).invalid, true);
  const now = Date.parse("2026-01-02T00:00:00Z");
  const write = (status) => writeFileSync(join(d, "s.json"), JSON.stringify({ last: { status, at: "2026-01-01T12:00:00Z" } }));
  write("pass");
  let r = scanStatusPanel({ ...base, file: join(d, "s.json") }, now);
  assert.equal(r.level, "ok");
  assert.equal(r.ageHours, 12);
  write("fail");
  assert.equal(scanStatusPanel({ ...base, file: join(d, "s.json") }, now).level, "fail");
  write("maturing");
  assert.equal(scanStatusPanel({ ...base, file: join(d, "s.json") }, now).level, "info");
  const only = scanStatusPanel({ ...base, file: join(d, "s.json"), fields: ["last.status", "nope"] }, now);
  assert.deepEqual(only.data, { "last.status": "maturing" }, "fields limits what reaches the page");
  writeFileSync(join(d, "s.json"), "{}");
  r = scanStatusPanel({ ...base, file: join(d, "s.json") }, now);
  assert.equal(r.status, null);
  assert.equal(r.level, "none");
  rmSync(d, { recursive: true });
});

// ---------- ui ----------
test("uiConfig: only sections whose source exists appear; tabs follow; status sits with the map", () => {
  const d = tmp();
  writeFileSync(join(d, "MAP.md"), MAP);
  writeFileSync(join(d, "s.json"), "{\"status\":\"pass\"}");
  mkdirSync(join(d, "claims"));
  const cfg = normalizeConfig({
    workspaceDir: d,
    validator: { enabled: true },
    sessions: { enabled: true, dir: "claims" },
    infraMap: { enabled: true, file: "MAP.md", tabLabel: "Cloud" },
    statusPanels: [{ label: "Health", file: "s.json" }, { label: "Gone", file: "missing.json" }],
  }, { platform: "linux", home: d });
  const ui = uiConfig(cfg, scanPanels(cfg));
  assert.deepEqual(ui.sections.map((s) => s.id), ["sessions", "validator", "cloud", "status-0"]);
  assert.deepEqual(ui.tabs.map((t) => t.id), ["code", "cloud"]);
  assert.equal(ui.sections.find((s) => s.id === "status-0").tab, "cloud");
  // without the map, the status panel falls back to the main tab and the Cloud tab disappears
  rmSync(join(d, "MAP.md"));
  const ui2 = uiConfig(cfg, scanPanels(cfg));
  assert.deepEqual(ui2.tabs.map((t) => t.id), ["code"]);
  assert.equal(ui2.sections.find((s) => s.id === "status-0").tab, "code");
  rmSync(d, { recursive: true });
});
