// claude-config-dashboard — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0, see LICENSE.md. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Optional panels for claude-config-dashboard — all OFF unless a config file turns them on.
 *
 * With no config file the dashboard behaves exactly like v1.1.0. A config file (JSON) adds:
 *   - brand        name / accent word / eyebrow / extra font / footer link
 *   - validator    live config checks (hook scripts exist, frontmatter, hardcoded home paths)
 *   - sessions     a "claim board": key=value *.claim files in a directory you choose
 *   - launchd      a "Local" tab of launchd jobs (macOS only; runs plutil + launchctl print, read-only)
 *   - infraMap     a "Cloud" tab rendering chosen `## N.` sections of a markdown file
 *   - statusPanels small JSON status files (e.g. a health check's last result), one panel each
 *
 * Every scanner here is a pure function of (config, filesystem[, command runner]) so it can be
 * tested without a server.
 */
import { statSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const safe = (fn, def) => { try { return fn(); } catch { return def; } };
const ls = (dir) => safe(() => readdirSync(dir), []);
const read = (p) => safe(() => readFileSync(p, "utf8"), "");
const BAD_KEYS = ["__proto__", "constructor", "prototype"];

export function expandHome(p, home = homedir()) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// resolve a config path: ~ expands; relative paths are taken from the workspace dir (if set).
export function resolveIn(p, base, home = homedir()) {
  const x = expandHome(p, home);
  if (!x) return null;
  if (isAbsolute(x)) return x;
  return base ? join(base, x) : null;
}

export const DEFAULT_CONFIG = Object.freeze({
  brand: { name: "Config", accent: "", eyebrow: "Claude Code", font: "", footerText: "built by SolanceLab", footerUrl: "https://github.com/SolanceLab" },
  workspaceDir: null,
  validator: { enabled: false },
  sessions: { enabled: false, dir: null, staleHours: 6, sub: "Which live session is working in which repo right now.", lede: "" },
  launchd: {
    enabled: false, prefixes: [], tabLabel: "Local", label: "Launchd",
    sub: "launchd jobs on this Mac — schedule, target health, exit codes, log freshness.",
    logTable: null, freshHours: 26, staleHours: 192,
  },
  infraMap: { enabled: false, file: null, sections: null, tabLabel: "Cloud", label: "Infra map", sub: "Parsed live from your infrastructure map.", tagKeys: ["HOT", "WARM", "DORMANT"] },
  statusPanels: [],
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v, d) => (typeof v === "string" ? v : d);
const num = (v, d) => (typeof v === "number" && isFinite(v) && v > 0 ? v : d);
const strList = (v, d) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : d);

/**
 * Normalize a raw config object into the full shape, filling defaults and dropping junk.
 * `platform` is injectable for tests; launchd is forced off anywhere but macOS.
 */
export function normalizeConfig(raw, { platform = process.platform, home = homedir() } = {}) {
  const r = isObj(raw) ? raw : {};
  const D = DEFAULT_CONFIG;
  const ws = resolveIn(str(r.workspaceDir, null), null, home);
  const b = isObj(r.brand) ? r.brand : {};
  const brand = {
    name: str(b.name, D.brand.name), accent: str(b.accent, D.brand.accent), eyebrow: str(b.eyebrow, D.brand.eyebrow),
    font: str(b.font, D.brand.font).replace(/[^\p{L}\p{N} \-]/gu, ""),
    footerText: str(b.footerText, D.brand.footerText),
    footerUrl: /^https?:\/\//.test(str(b.footerUrl, "")) ? b.footerUrl : D.brand.footerUrl,
  };
  const s = isObj(r.sessions) ? r.sessions : {};
  const sessions = {
    enabled: s.enabled === true, dir: resolveIn(str(s.dir, null), ws, home),
    staleHours: num(s.staleHours, D.sessions.staleHours), sub: str(s.sub, D.sessions.sub), lede: str(s.lede, D.sessions.lede),
  };
  const l = isObj(r.launchd) ? r.launchd : {};
  const lt = isObj(l.logTable) ? l.logTable : null;
  const launchd = {
    enabled: l.enabled === true && platform === "darwin",
    prefixes: strList(l.prefixes, []),
    tabLabel: str(l.tabLabel, D.launchd.tabLabel), label: str(l.label, D.launchd.label), sub: str(l.sub, D.launchd.sub),
    freshHours: num(l.freshHours, D.launchd.freshHours), staleHours: num(l.staleHours, D.launchd.staleHours),
    logTable: lt && lt.file ? {
      file: resolveIn(lt.file, ws, home), section: str(lt.section, ""),
      jobColumn: Number.isInteger(lt.jobColumn) ? lt.jobColumn : 1,
      logColumn: Number.isInteger(lt.logColumn) ? lt.logColumn : 4,
      searchDirs: strList(lt.searchDirs, []).map((d) => resolveIn(d, ws, home)).filter(Boolean),
    } : null,
  };
  if (launchd.logTable && ws && !launchd.logTable.searchDirs.length) launchd.logTable.searchDirs = [ws];
  const im = isObj(r.infraMap) ? r.infraMap : {};
  const infraMap = {
    enabled: im.enabled === true && !!im.file, file: resolveIn(str(im.file, null), ws, home),
    sections: Array.isArray(im.sections) ? im.sections.map(String) : null,
    tabLabel: str(im.tabLabel, D.infraMap.tabLabel), label: str(im.label, D.infraMap.label), sub: str(im.sub, D.infraMap.sub),
    tagKeys: strList(im.tagKeys, D.infraMap.tagKeys).filter((k) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(k)),
  };
  const statusPanels = (Array.isArray(r.statusPanels) ? r.statusPanels : []).filter(isObj).map((p, i) => ({
    id: "status-" + i,
    label: str(p.label, "Status " + (i + 1)), sub: str(p.sub, ""), lede: str(p.lede, ""),
    file: resolveIn(str(p.file, null), ws, home),
    statusKey: str(p.statusKey, "status"), timeKey: str(p.timeKey, ""),
    failValues: strList(p.failValues, ["fail", "error", "failed"]),
    okValues: strList(p.okValues, ["pass", "ok", "green", "healthy"]),
    fields: Array.isArray(p.fields) ? strList(p.fields, []) : null,
  })).filter((p) => p.file);
  const v = isObj(r.validator) ? r.validator : {};
  return { brand, workspaceDir: ws, validator: { enabled: v.enabled === true }, sessions, launchd, infraMap, statusPanels };
}

/** Load config from CONFIG_FILE, else ~/.claude/dashboard.config.json, else defaults. */
export function loadConfig({ env = process.env, claudeDir = join(homedir(), ".claude"), platform, home } = {}) {
  const file = env.CONFIG_FILE ? expandHome(env.CONFIG_FILE, home) : join(claudeDir, "dashboard.config.json");
  const text = safe(() => readFileSync(file, "utf8"), null);
  let raw = {};
  let error = null;
  if (text !== null) { raw = safe(() => JSON.parse(text), null); if (raw === null) { raw = {}; error = "config file is not valid JSON"; } }
  if (env.WORKSPACE_DIR) raw = { ...raw, workspaceDir: env.WORKSPACE_DIR };
  if (env.CLAIMS_DIR) raw = { ...raw, sessions: { enabled: true, ...(isObj(raw.sessions) ? raw.sessions : {}), dir: env.CLAIMS_DIR } };
  return { config: normalizeConfig(raw, { platform, home }), file: text === null ? null : file, error };
}

// ---------- sessions (claim board) ----------
export function parseClaim(text) {
  const kv = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^([a-z]+)=(.*)$/);
    if (m && !BAD_KEYS.includes(m[1])) kv[m[1]] = m[2];
  }
  return kv;
}

export function scanClaims(cfg, now = Date.now()) {
  if (!cfg.enabled || !cfg.dir) return null;
  if (!safe(() => statSync(cfg.dir).isDirectory(), false)) return null;
  const staleMs = cfg.staleHours * 3600 * 1000;
  const out = [];
  for (const f of ls(cfg.dir)) {
    if (!f.endsWith(".claim")) continue;
    const p = join(cfg.dir, f);
    const mtime = safe(() => statSync(p).mtimeMs, 0);
    if (now - mtime > staleMs) continue;
    const kv = parseClaim(read(p));
    out.push({ repo: f.replace(/\.claim$/, ""), session: kv.session || "?", since: kv.since || "", purpose: kv.purpose || "" });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

// ---------- markdown helpers ----------
export function splitSections(text) {
  return String(text || "").split(/\n(?=## )/);
}

/**
 * Parse a markdown table (inside the `## <section>` section) mapping launchd label → log path.
 * Paths may be absolute, ~/, relative to searchDirs, or brace sets (`logs/{a,b}.log` → newest wins).
 * A parenthesised note in the log cell is kept as `note`; "—" means "no log".
 */
export function parseLogTable(text, { section = "", jobColumn = 1, logColumn = 4, searchDirs = [], home = homedir() } = {}) {
  const sec = splitSections(text).find((s) => s.startsWith("## " + section)) || "";
  const out = new Map();
  if (!sec || (!section && !sec.startsWith("## "))) return out;
  const expandBrace = (p) => {
    const m = p.match(/^(.*)\{([^{}]+)\}(.*)$/);
    return m ? m[2].split(",").map((x) => m[1] + x.trim() + m[3]) : [p];
  };
  const resolvePath = (p) => {
    const x = expandHome(p, home);
    if (isAbsolute(x)) return x;
    const tries = searchDirs.map((d) => join(d, x));
    return tries.find((t) => existsSync(t)) || tries[0] || null;
  };
  for (const line of sec.split(/\r?\n/).filter((l) => l.trim().startsWith("|"))) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.every((c) => !c || /^:?-+:?$/.test(c))) continue;
    const job = cells[jobColumn] || "";
    if (!job || /^job$/i.test(job)) continue;
    const logRaw = cells[logColumn] || "";
    const note = ((logRaw.match(/\(([^)]*)\)/) || [])[1] || "").trim();
    const token = logRaw.replace(/\([^)]*\)/g, "").replace(/`/g, "").trim().split(/\s+/)[0] || "";
    if (!token || token === "—" || token === "-") { out.set(job, { logPath: null, note }); continue; }
    const candidates = expandBrace(token).map(resolvePath).filter(Boolean);
    const existing = candidates
      .filter((p) => existsSync(p))
      .map((p) => ({ p, m: safe(() => statSync(p).mtimeMs, 0) }))
      .sort((a, b) => b.m - a.m);
    out.set(job, { logPath: existing[0] ? existing[0].p : candidates[0] || null, note });
  }
  return out;
}

// ---------- launchd ----------
export function scheduleOf(plist) {
  const pad2 = (n) => String(n || 0).padStart(2, "0");
  if (plist.StartCalendarInterval) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const iv = Array.isArray(plist.StartCalendarInterval) ? plist.StartCalendarInterval : [plist.StartCalendarInterval];
    return iv.map((x) => (x.Weekday !== undefined ? (days[x.Weekday % 7] || "?") + " " : "daily ") + pad2(x.Hour) + ":" + pad2(x.Minute)).join(" · ");
  }
  if (plist.StartInterval) {
    const n = plist.StartInterval;
    return "every " + (n % 3600 === 0 ? (n / 3600) + "h" : n % 60 === 0 ? (n / 60) + "m" : n + "s");
  }
  if (plist.KeepAlive === true) return "KeepAlive";
  if (plist.KeepAlive && typeof plist.KeepAlive === "object") return plist.KeepAlive.SuccessfulExit === false ? "KeepAlive on fail" : "KeepAlive (conditional)";
  return "RunAtLoad only";
}

/** Parse `launchctl print gui/<uid>/<label>` output. null input = not loaded. */
export function parseLaunchctlPrint(out) {
  if (out === null || out === undefined) return { loaded: false, state: null, running: false, pid: null, lastExit: null };
  const state = (out.match(/^\s*state = (.+)$/m) || [])[1] || null;
  return {
    loaded: true, state, running: state === "running",
    pid: (out.match(/^\s*pid = (\d+)$/m) || [])[1] || null,
    lastExit: (out.match(/last exit code = (-?\d+)/) || [])[1] ?? null,
  };
}

const defaultRun = (cmd, args) => safe(() => execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }), null);

/**
 * List launchd agents in ~/Library/LaunchAgents whose file name starts with a configured prefix.
 * Read-only: runs `plutil -convert json -o - <plist>` and `launchctl print gui/<uid>/<label>`.
 * Full paths stay server-side; the browser gets basenames and tails only.
 */
export function scanLaunchd(cfg, { run = defaultRun, home = homedir(), now = Date.now(), uid = safe(() => process.getuid(), 0) } = {}) {
  if (!cfg.enabled || !cfg.prefixes.length) return null;
  const agents = join(home, "Library", "LaunchAgents");
  const logs = cfg.logTable && cfg.logTable.file
    ? parseLogTable(read(cfg.logTable.file), { ...cfg.logTable, home })
    : new Map();
  const jobs = [];
  for (const f of ls(agents).filter((n) => n.endsWith(".plist") && cfg.prefixes.some((p) => n.startsWith(p)))) {
    const plist = safe(() => JSON.parse(run("plutil", ["-convert", "json", "-o", "-", join(agents, f)])), null);
    if (!isObj(plist)) continue;
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : (plist.Program ? [plist.Program] : []);
    const label = typeof plist.Label === "string" ? plist.Label : f.replace(/\.plist$/, "");
    if (!/^[A-Za-z0-9._-]+$/.test(label)) continue;
    let target = args.slice(1).find((a) => typeof a === "string" && (a.startsWith("/") || a.startsWith("~/"))) || args[0] || "";
    target = expandHome(String(target), home) || "";
    const targetDirect = target === args[0];
    const targetExists = !!target && existsSync(target);
    const execBitOk = targetExists && (targetDirect ? (safe(() => statSync(target).mode, 0) & 0o111) !== 0 : true);
    const st = parseLaunchctlPrint(run("launchctl", ["print", "gui/" + uid + "/" + label]));
    const logInfo = logs.get(label) || { logPath: null, note: "" };
    const logMtime = logInfo.logPath ? safe(() => statSync(logInfo.logPath).mtimeMs, 0) : 0;
    const ageH = logMtime ? (now - logMtime) / 3600000 : null;
    const logColor = !cfg.logTable ? "none" : (!logInfo.logPath || !logMtime ? "red" : ageH < cfg.freshHours ? "green" : ageH < cfg.staleHours ? "amber" : "red");
    jobs.push({
      label, schedule: scheduleOf(plist),
      targetBase: target.split("/").pop(), targetExists, execBitOk,
      loaded: st.loaded, running: st.running, pid: st.pid, lastExit: st.lastExit,
      logTail: logInfo.logPath ? logInfo.logPath.split("/").slice(-2).join("/") : null,
      logAgeH: ageH === null ? null : Math.round(ageH * 10) / 10,
      logColor, note: logInfo.note,
    });
  }
  return { jobs: jobs.sort((a, b) => a.label.localeCompare(b.label)), hasLogTable: !!cfg.logTable, freshHours: cfg.freshHours, staleHours: cfg.staleHours };
}

// ---------- infra map (markdown sections) ----------
/**
 * Render `## N. Title` sections of a markdown file (all numbered ones, or only `sections`).
 * A line `*Verified …*` becomes the section's stamp. Lines `KEY…: a (hint), b` for KEY in
 * tagKeys become tag groups.
 */
export function parseInfraMap(text, { sections = null, tagKeys = [] } = {}) {
  if (text === null || text === undefined) return { sections: [], missing: true };
  const out = [];
  const tagRe = tagKeys.length ? new RegExp("^(" + tagKeys.join("|") + ")[^:\\n]*:\\s*(.+)$", "gm") : null;
  for (const sec of splitSections(text)) {
    const hm = sec.match(/^## (\d+)\.\s*(.+)$/m);
    if (!hm || (sections && !sections.includes(hm[1]))) continue;
    const stampLine = (sec.match(/^\*Verified[^*]*\*$/m) || [""])[0];
    const body = sec.split(/\r?\n/).slice(1).filter((l) => !stampLine || l !== stampLine).join("\n").trim();
    let tags = null;
    if (tagRe) {
      for (const m of body.matchAll(tagRe)) {
        tags = tags || Object.fromEntries(tagKeys.map((k) => [k, []]));
        tags[m[1]] = m[2].split(",").map((raw) => ({
          name: raw.replace(/\([^)]*\)/g, "").replace(/\*\*/g, "").replace(/\.$/, "").trim(),
          hint: ((raw.match(/\(([^)]*)\)/) || [])[1] || "").trim(),
        })).filter((x) => x.name);
      }
    }
    out.push({ num: hm[1], title: hm[1] + ". " + hm[2].trim(), stamp: stampLine.replace(/^\*|\*$/g, ""), body, tags });
  }
  return { sections: out, missing: false };
}

export function scanInfraMap(cfg) {
  if (!cfg.enabled || !cfg.file) return null;
  const text = safe(() => readFileSync(cfg.file, "utf8"), null);
  if (text === null) return null; // hide the tab when the file is absent
  return parseInfraMap(text, cfg);
}

// ---------- status panels ----------
export const getPath = (obj, path) => (path ? path.split(".") : []).reduce((o, k) => (o && typeof o === "object" && !BAD_KEYS.includes(k) ? o[k] : undefined), obj);

/** Read one JSON status file. Hidden (null) when the file doesn't exist. */
export function scanStatusPanel(p, now = Date.now()) {
  const text = safe(() => readFileSync(p.file, "utf8"), null);
  if (text === null) return null;
  const data = safe(() => JSON.parse(text), undefined);
  if (data === undefined) return { id: p.id, invalid: true, data: null, status: null, level: "fail", ageHours: null };
  const raw = getPath(data, p.statusKey);
  const status = raw === undefined || raw === null ? null : String(raw);
  const level = status === null ? "none" : p.failValues.includes(status) ? "fail" : p.okValues.includes(status) ? "ok" : "info";
  let ageHours = null;
  const t = p.timeKey ? getPath(data, p.timeKey) : undefined;
  if (t) { const ms = new Date(t).getTime(); if (isFinite(ms)) ageHours = (now - ms) / 3600000; }
  // `fields` (dotted paths) limits what reaches the page; without it the whole file is shown.
  const shown = p.fields ? Object.fromEntries(p.fields.map((f) => [f, getPath(data, f)]).filter(([, v]) => v !== undefined)) : data;
  return { id: p.id, invalid: false, data: shown, status, level, ageHours };
}

/** Everything the optional panels contribute to one /api/data snapshot. */
export function scanPanels(config, opts = {}) {
  const sessions = scanClaims(config.sessions, opts.now);
  const local = scanLaunchd(config.launchd, opts);
  const cloud = scanInfraMap(config.infraMap);
  const status = config.statusPanels.map((p) => scanStatusPanel(p, opts.now)).filter(Boolean);
  return { sessions, local, cloud, status };
}

/** The UI description sent into the page: which sections exist, their labels, and branding. */
export function uiConfig(config, panels) {
  const sections = [];
  if (panels.sessions) sections.push({ id: "sessions", label: "Sessions", tab: "code", sub: config.sessions.sub, lede: config.sessions.lede });
  if (config.validator.enabled) sections.push({ id: "validator", label: "Validator", tab: "code", sub: "Live config checks — failures first, passes collapsed." });
  if (panels.local) sections.push({ id: "local", label: config.launchd.label, tab: "local", sub: config.launchd.sub });
  if (panels.cloud) sections.push({ id: "cloud", label: config.infraMap.label, tab: "cloud", sub: config.infraMap.sub });
  for (const s of panels.status) {
    const p = config.statusPanels.find((x) => x.id === s.id);
    sections.push({ id: s.id, label: p.label, tab: panels.cloud ? "cloud" : "code", sub: p.sub, lede: p.lede, status: true });
  }
  const tabs = [{ id: "code", label: "Claude Code" }];
  if (panels.local) tabs.push({ id: "local", label: config.launchd.tabLabel });
  if (panels.cloud) tabs.push({ id: "cloud", label: config.infraMap.tabLabel });
  return { brand: config.brand, sections, tabs, tagKeys: config.infraMap.tagKeys };
}
