#!/usr/bin/env node
/**
 * claude-config-dashboard — a local, always-fresh view of everything in ~/.claude/:
 * skills, agents, commands, workflows, hooks, permissions, env, plugins, and rules.
 *
 * Binds 127.0.0.1 only. Scans the filesystem LIVE on every request, so it can never go
 * stale. Masks secret-shaped values. Read-only. No external dependencies, no telemetry.
 *
 *   node server.mjs                 # http://localhost:7373
 *   PORT=8080 node server.mjs       # custom port
 *   CLAUDE_DIR=/path node server.mjs        # point at a non-default ~/.claude
 *   CLAUDE_MEMORY_DIR=/path node server.mjs # pin the memory dir (else auto-discovered)
 */
import { createServer } from "node:http";
import {
  existsSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = process.env.CLAUDE_DIR || join(homedir(), ".claude");
const PORT = parseInt(process.env.PORT || "7373", 10);

// ---------- helpers ----------
const safe = (fn, def) => { try { return fn(); } catch { return def; } };
const ls = (dir) => safe(() => readdirSync(dir), []);
const isDir = (p) => safe(() => statSync(p).isDirectory(), false);
const read = (p) => safe(() => readFileSync(p, "utf8"), "");

// Memory lives per-project under ~/.claude/projects/<id>/memory/MEMORY.md. There's no
// single canonical one, so auto-discover: honor CLAUDE_MEMORY_DIR, else pick the most
// recently modified MEMORY.md. Returns null if this install has no memory index.
function findMemoryDir() {
  if (process.env.CLAUDE_MEMORY_DIR) return process.env.CLAUDE_MEMORY_DIR;
  const projects = join(ROOT, "projects");
  let best = null, bestMtime = 0;
  for (const p of ls(projects)) {
    const md = join(projects, p, "memory", "MEMORY.md");
    if (existsSync(md)) {
      const m = safe(() => statSync(md).mtimeMs, 0);
      if (m > bestMtime) { bestMtime = m; best = join(projects, p, "memory"); }
    }
  }
  return best;
}
const MEM_DIR = findMemoryDir();

// allow-list of readable files, rebuilt each snapshot. The browser only ever gets opaque
// integer ids (DOC_INDEX keys); raw paths never cross the wire, so there is no path to traverse.
let DOC_INDEX = new Map();

// mask anything that smells like a secret. Specific provider shapes first, then a
// conservative long-opaque-token catch-all. No suffix is ever preserved.
const SECRET_RE = new RegExp([
  "gh[pousr]_[A-Za-z0-9]{10,}",                                  // GitHub tokens
  "sk-(?:proj|ant|live|test)-[A-Za-z0-9_-]{8,}",                 // OpenAI/Anthropic prefixed
  "sk-[A-Za-z0-9]{20,}",                                         // generic sk- keys
  "xox[baprs]-[A-Za-z0-9-]{10,}",                                // Slack
  "AKIA[0-9A-Z]{16}",                                            // AWS access key id
  "AIza[0-9A-Za-z_-]{35}",                                       // Google API key
  "eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}", // full JWT (3 segments)
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----", // PEM
  "(?=[A-Za-z0-9+_-]*[0-9])[A-Za-z0-9+_-]{40,}={0,2}",           // long opaque token w/ a digit — NOT slashes (paths) or all-letter tool names
].join("|"), "g");
// labeled-secret patterns: catch short/structured secrets the shape regex misses,
// e.g. `password=hunter2`, `api_key: abc`, `Authorization: ...`, `Bearer xyz`.
const KEYVAL_RE = /([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|bearer|access[_-]?key|client[_-]?secret|private[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^"'\s&)]{3,})/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._-]{6,}/gi;
const mask = (s) => {
  if (s == null) return s;
  return String(s)
    .replace(SECRET_RE, "[masked]")
    .replace(KEYVAL_RE, "$1$2[masked]")
    .replace(BEARER_RE, "$1[masked]");
};
// defense-in-depth: mask EVERY outbound string, so a secret accidentally sitting in a
// skill description, workflow meta, or CLAUDE header can never reach the wire either.
function deepMask(v) {
  if (typeof v === "string") return mask(v);
  if (Array.isArray(v)) return v.map(deepMask);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = deepMask(val);
    return o;
  }
  return v;
}

// catalogue of known settings.json keys — drives the full read-only table (set + unset/default),
// the tier badge, and a future editor. tier: safe (fine to toggle) · caution (changes behaviour) ·
// danger (bypasses safety / admin-only). type + def let the table show defaults for unset keys.
const SETTINGS_CATALOG = {
  // model & behaviour
  model: { tier: "safe", type: "string" },
  advisorModel: { tier: "safe", type: "string" },
  effortLevel: { tier: "safe", type: "enum", enum: ["low", "medium", "high", "xhigh"] },
  temperatureOverride: { tier: "safe", type: "number" },
  alwaysThinkingEnabled: { tier: "safe", type: "bool", def: false },
  showThinkingSummaries: { tier: "safe", type: "bool", def: false },
  autoCompactEnabled: { tier: "safe", type: "bool", def: true },
  awaySummaryEnabled: { tier: "safe", type: "bool", def: true },
  autoMemoryEnabled: { tier: "safe", type: "bool", def: true },
  // ui
  editorMode: { tier: "safe", type: "enum", enum: ["normal", "vim"], def: "normal" },
  tui: { tier: "safe", type: "bool", def: true },
  autoScrollEnabled: { tier: "safe", type: "bool", def: true },
  prefersReducedMotion: { tier: "safe", type: "bool", def: false },
  spinnerTipsEnabled: { tier: "safe", type: "bool" },
  language: { tier: "safe", type: "string" },
  // notifications
  preferredNotifChannel: { tier: "safe", type: "enum", enum: ["auto", "terminal_bell", "iterm2", "iterm2_with_bell", "kitty", "ghostty", "notifications_disabled"], def: "auto" },
  inputNeededNotifEnabled: { tier: "safe", type: "bool", def: false },
  agentPushNotifEnabled: { tier: "safe", type: "bool", def: false },
  remoteControlAtStartup: { tier: "safe", type: "bool" },
  // dev conveniences
  verbose: { tier: "safe", type: "bool", def: false },
  includeGitInstructions: { tier: "safe", type: "bool", def: true },
  respectGitignore: { tier: "safe", type: "bool", def: true },
  fileCheckpointingEnabled: { tier: "safe", type: "bool", def: true },
  defaultShell: { tier: "safe", type: "enum", enum: ["bash", "powershell"], def: "bash" },
  autoUpdatesChannel: { tier: "safe", type: "enum", enum: ["stable", "latest"], def: "latest" },
  // caution
  disableWorkflows: { tier: "caution", type: "bool", def: false },
  disableBundledSkills: { tier: "caution", type: "bool", def: false },
  disableSkillShellExecution: { tier: "caution", type: "bool", def: false },
  disableAgentView: { tier: "caution", type: "bool", def: false },
  fastModePerSessionOptIn: { tier: "caution", type: "bool", def: false },
  autoMemoryDirectory: { tier: "caution", type: "string" },
  attribution: { tier: "caution", type: "object" },
  includeCoAuthoredBy: { tier: "caution", type: "bool", def: true },
  minimumVersion: { tier: "caution", type: "string" },
  // danger
  skipAutoPermissionPrompt: { tier: "danger", type: "bool" },
  skipDangerousModePermissionPrompt: { tier: "danger", type: "bool" },
  disableAllHooks: { tier: "danger", type: "bool" },
  disableArtifact: { tier: "danger", type: "bool" },
  disableRemoteControl: { tier: "danger", type: "bool" },
  disableClaudeAiConnectors: { tier: "danger", type: "bool" },
  cleanupPeriodDays: { tier: "danger", type: "number", def: 30 },
  apiKeyHelper: { tier: "danger", type: "string" },
  policyHelper: { tier: "danger", type: "object" },
};
const tierOf = (k) => (SETTINGS_CATALOG[k] && SETTINGS_CATALOG[k].tier) || "info";

// minimal frontmatter parse (no yaml dep): grab top-level scalar keys
function frontmatter(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (km && !["__proto__", "constructor", "prototype"].includes(km[1])) {
      out[km[1]] = km[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return out;
}
const firstSentence = (s) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 220 ? t.slice(0, 217) + "…" : t;
};

// ---------- scanners ----------
function scanSkills(dir, source) {
  const out = [];
  for (const name of ls(dir)) {
    const sk = join(dir, name, "SKILL.md");
    if (existsSync(sk)) {
      const fm = frontmatter(read(sk));
      out.push({ name: fm.name || name, description: firstSentence(fm.description), source, path: sk });
    }
  }
  return out;
}
function scanMdDir(dir, source) {
  const out = [];
  for (const f of ls(dir)) {
    if (!f.endsWith(".md")) continue;
    const fm = frontmatter(read(join(dir, f)));
    out.push({
      name: fm.name || f.replace(/\.md$/, ""),
      description: firstSentence(fm.description || ""),
      source,
      path: join(dir, f),
    });
  }
  return out;
}
function scanWorkflows(dir) {
  const out = [];
  for (const f of ls(dir)) {
    if (!f.endsWith(".js")) continue;
    const text = read(join(dir, f));
    const metaBlock = (text.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/) || [, ""])[1];
    const grab = (k) => (metaBlock.match(new RegExp(`${k}\\s*:\\s*['"\`]([^'"\`]*)`)) || [, ""])[1];
    out.push({
      name: grab("name") || f.replace(/\.js$/, ""),
      description: firstSentence(grab("description")),
      source: "workflows/",
      path: join(dir, f),
    });
  }
  return out;
}

function scanSettings() {
  const s = safe(() => JSON.parse(read(join(ROOT, "settings.json"))), {});
  const local = safe(() => JSON.parse(read(join(ROOT, "settings.local.json"))), {});
  const hooks = [];
  for (const [event, entries] of Object.entries(s.hooks || {})) {
    for (const entry of entries || []) {
      for (const h of entry.hooks || []) {
        hooks.push({
          event,
          matcher: entry.matcher || "*",
          type: h.type,
          command: mask(firstSentence(h.command || h.type || "")),
          commandFull: mask(h.command || h.type || ""),
        });
      }
    }
  }
  const perms = s.permissions || {};
  // full reflection of every top-level key (minus the ones rendered structurally), tier-badged + read-only.
  const STRUCTURAL = new Set(["permissions", "hooks", "env", "enabledPlugins", "extraKnownMarketplaces", "mcpServers"]);
  const display = (v) => {
    if (v === null) return "null";
    if (Array.isArray(v)) return "[" + v.length + "]";
    if (typeof v === "object") return "{" + Object.keys(v).length + " keys}";
    return String(v);
  };
  // every catalogued key — whether set in this install or not — plus any uncatalogued keys present.
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const TR = { safe: 0, caution: 1, danger: 2, info: 3 };
  const all = [];
  for (const [key, meta] of Object.entries(SETTINGS_CATALOG)) {
    const set = has(key);
    all.push({
      key, tier: meta.tier, type: meta.type, set,
      value: set ? display(s[key]) : (meta.def !== undefined ? String(meta.def) : "—"),
    });
  }
  for (const key of Object.keys(s)) {
    if (!SETTINGS_CATALOG[key] && !STRUCTURAL.has(key)) {
      all.push({ key, tier: "info", type: "other", set: true, value: display(s[key]) });
    }
  }
  all.sort((a, b) => (TR[a.tier] - TR[b.tier]) || a.key.localeCompare(b.key));
  return {
    model: s.model || "(default)",
    effortLevel: s.effortLevel || "(default)",
    defaultMode: perms.defaultMode || "(default)",
    editorMode: s.editorMode || "(default)",
    envKeys: Object.keys(s.env || {}),
    additionalDirectories: perms.additionalDirectories || [],
    all,
    hooks,
    permissions: {
      allow: (perms.allow || []).map(mask),
      deny: (perms.deny || []).map(mask),
      ask: (perms.ask || []).map(mask),
    },
    hasLocalSettings: Object.keys(local).length > 0,
  };
}

// MCP servers live in ~/.claude.json (user-global + per-project). Their configs hold secrets in
// env/args/headers/url — so we surface ONLY name, transport type, a command basename or url host,
// and env KEY names. Never args values, env values, headers, or full URLs.
function scanMcp() {
  const cfg = safe(() => JSON.parse(read(join(homedir(), ".claude.json"))), {});
  const out = [];
  const norm = (name, def, scope) => {
    def = def || {};
    const type = def.type || (def.command ? "stdio" : def.url ? "http" : "?");
    let detail = "";
    if (def.command) detail = String(def.command).split("/").pop() + (Array.isArray(def.args) && def.args.length ? ` · ${def.args.length} args` : "");
    else if (def.url) { detail = safe(() => new URL(def.url).host, "(url)"); }
    out.push({ name, type, detail, envKeys: def.env ? Object.keys(def.env) : [], scope });
  };
  for (const [name, def] of Object.entries(cfg.mcpServers || {})) norm(name, def, "user");
  for (const pdef of Object.values(cfg.projects || {})) {
    for (const [name, def] of Object.entries((pdef && pdef.mcpServers) || {})) norm(name, def, "project");
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// plugin marketplaces (sources plugins are installed from)
function scanMarketplaces() {
  const m = safe(() => JSON.parse(read(join(ROOT, "plugins", "known_marketplaces.json"))), {});
  const out = [];
  const entries = Array.isArray(m) ? m.map((x, i) => [x.name || x.id || String(i), x]) : Object.entries(m || {});
  const clean = (u) => { try { const url = new URL(u); return url.host + url.pathname; } catch { return u; } };
  for (const [name, v] of entries) {
    const src = v && v.source;
    const repo = src && (src.repo || src.url || src.source);
    out.push({ name, source: clean(repo || (typeof src === "string" ? src : "")) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanPlugins() {
  const installed = safe(
    () => JSON.parse(read(join(ROOT, "plugins", "installed_plugins.json"))), { plugins: {} }
  );
  const enabled = safe(() => JSON.parse(read(join(ROOT, "settings.json"))).enabledPlugins, {}) || {};
  const out = [];
  for (const [id, instances] of Object.entries(installed.plugins || {})) {
    const inst = (instances || [])[0] || {};
    let provides = { skills: 0, commands: 0, agents: 0 };
    if (inst.installPath) {
      provides = {
        skills: ls(join(inst.installPath, "skills")).filter((n) => isDir(join(inst.installPath, "skills", n))).length,
        commands: ls(join(inst.installPath, "commands")).filter((f) => f.endsWith(".md")).length,
        agents: ls(join(inst.installPath, "agents")).filter((f) => f.endsWith(".md")).length,
      };
    }
    let path = null;
    if (inst.installPath) {
      for (const c of [join(inst.installPath, ".claude-plugin", "plugin.json"),
                       join(inst.installPath, "plugin.json"),
                       join(inst.installPath, "README.md")]) {
        if (existsSync(c)) { path = c; break; }
      }
    }
    out.push({
      id,
      version: inst.version || "?",
      scope: inst.scope || "?",
      enabled: enabled[id] !== false, // absent or true => enabled; explicit false => disabled
      provides,
      path,
    });
  }
  return out;
}

function scanRules() {
  const claudeMd = join(ROOT, "CLAUDE.md");
  const text = read(claudeMd);
  const headers = (text.match(/^#{1,2}\s+(.+)$/gm) || []).map((h) => h.replace(/^#+\s+/, "")).slice(0, 40);
  const memIdx = MEM_DIR ? join(MEM_DIR, "MEMORY.md") : null;
  const memText = memIdx ? read(memIdx) : "";
  const memories = [];
  let group = "";
  for (const line of memText.split(/\r?\n/)) {
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) { group = h[1].trim(); continue; }
    const m = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*(.*))?$/);
    if (m) {
      const file = m[2].trim();
      const base = file.split("/").pop();
      const readable = MEM_DIR && /^[A-Za-z0-9._-]+\.md$/.test(base) && existsSync(join(MEM_DIR, base));
      memories.push({ title: m[1].trim(), file: readable ? base : file, hook: (m[3] || "").trim(), group, readable });
    }
  }
  return {
    claudeMd: { exists: existsSync(claudeMd), bytes: text.length, headers },
    memory: { exists: !!memIdx && existsSync(memIdx), entries: memories.length, items: memories, dir: MEM_DIR || "" },
  };
}

function snapshot() {
  const skills = [...scanSkills(join(ROOT, "skills"), "skills/")];
  const agents = [...scanMdDir(join(ROOT, "agents"), "agents/")];
  const commands = [...scanMdDir(join(ROOT, "commands"), "commands/")];
  const installed = safe(() => JSON.parse(read(join(ROOT, "plugins", "installed_plugins.json"))), { plugins: {} });
  for (const [pid, instances] of Object.entries(installed.plugins || {})) {
    const inst = (instances || [])[0] || {};
    if (!inst.installPath) continue;
    const tag = `plugin:${pid}`;
    skills.push(...scanSkills(join(inst.installPath, "skills"), tag));
    agents.push(...scanMdDir(join(inst.installPath, "agents"), tag));
    commands.push(...scanMdDir(join(inst.installPath, "commands"), tag));
  }
  const out = {
    scannedAt: new Date().toISOString(),
    root: ROOT,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    commands: commands.sort((a, b) => a.name.localeCompare(b.name)),
    workflows: scanWorkflows(join(ROOT, "workflows")).sort((a, b) => a.name.localeCompare(b.name)),
    mcp: scanMcp(),
    marketplaces: scanMarketplaces(),
    settings: scanSettings(),
    plugins: scanPlugins().sort((a, b) => a.id.localeCompare(b.id)),
    rules: scanRules(),
  };

  // register every readable file as an opaque id; strip the raw path so it never crosses the wire.
  DOC_INDEX = new Map();
  let seq = 0;
  const reg = (absPath) => { if (!absPath || !existsSync(absPath)) return undefined; const id = ++seq; DOC_INDEX.set(id, absPath); return id; };
  const attach = (arr) => arr.forEach((it) => { it.doc = reg(it.path); delete it.path; });
  attach(out.skills); attach(out.agents); attach(out.commands); attach(out.workflows);
  out.plugins.forEach((p) => { p.doc = reg(p.path); delete p.path; });
  (out.rules.memory.items || []).forEach((m) => { if (m.readable && MEM_DIR) m.doc = reg(join(MEM_DIR, m.file)); });
  out.rules.claudeMd.doc = reg(join(ROOT, "CLAUDE.md"));
  return out;
}

// ---------- HTTP ----------
const server = createServer((req, res) => {
  // DNS-rebinding + cross-site guard: a 127.0.0.1 bind alone doesn't stop a hostile page from
  // rebinding DNS to loopback and reading this. Require a loopback Host and reject cross-site.
  const okHost = ["127.0.0.1:" + PORT, "localhost:" + PORT].includes(req.headers.host);
  const origin = req.headers.origin;
  const okOrigin = !origin || ["http://127.0.0.1:" + PORT, "http://localhost:" + PORT].includes(origin);
  if (!okHost || req.headers["sec-fetch-site"] === "cross-site" || !okOrigin) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith("/api/data")) {
    json(200, deepMask(snapshot()));
    return;
  }
  // read a single doc by its opaque id. The id must be a key the last snapshot registered
  // in DOC_INDEX — the browser cannot name an arbitrary path, so traversal is impossible.
  if (req.url.startsWith("/api/doc")) {
    const id = Number(new URL(req.url, "http://x").searchParams.get("id"));
    const file = DOC_INDEX.get(id);
    if (!file || !existsSync(file)) return json(404, { error: "unknown or stale id — refresh" });
    return json(200, { text: mask(read(file)) });
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-config-dashboard → http://localhost:${PORT}  (scanning ${ROOT} live)`);
});

// ---------- the page ----------
const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code · Config</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Inter+Tight:wght@300;400;500&family=JetBrains+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
  :root{
    --serif:"Cormorant Garamond","EB Garamond",Georgia,serif;
    --sans:"Inter Tight",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --mono:"JetBrains Mono","IBM Plex Mono","SF Mono",Menlo,monospace;
    --page:#e8e3d4; --page-strong:#f4efe0; --page-dim:#b8b3a4; --page-muted:#9a9483; --page-faint:#5a5549;
    --ink:#06090f; --ink-deep:#0b111c; --ink-raised:#111826; --ink-raised-2:#182234;
    --gold:#BA7517; --gold-text:#e09b41; --gold-soft:rgba(186,117,23,.45); --gold-glow:rgba(186,117,23,.08);
    --blue:#378ADD; --blue-text:#6fb0ec; --blue-soft:rgba(55,138,221,.22);
    --rule-strong:rgba(232,227,212,.34); --rule-mid:rgba(232,227,212,.18); --rule-dim:rgba(232,227,212,.10);
    --ease:cubic-bezier(.2,.6,.2,1);
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--ink);color:var(--page);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
  ::selection{background:var(--gold-glow)}
  .app{display:flex;min-height:100vh}
  .side{width:248px;flex:none;background:var(--ink-deep);border-right:1px solid var(--rule-dim);
    position:sticky;top:0;height:100vh;overflow:auto;padding:26px 18px;display:flex;flex-direction:column;gap:6px}
  .brand{padding:0 8px 4px}
  .brand .ey{font-family:var(--mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--page-muted);font-weight:300}
  .brand h1{font-family:var(--serif);font-weight:500;font-size:29px;line-height:1.05;margin:6px 0 0;letter-spacing:-.01em;color:var(--page)}
  .rule{height:1px;width:44px;background:var(--gold-soft);margin:14px 8px 16px}
  nav{display:flex;flex-direction:column;gap:2px}
  .nav{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;border-radius:8px;cursor:pointer;
    color:var(--page-dim);border:1px solid transparent;text-align:left;width:100%;background:none;
    font-family:var(--sans);font-size:14px;transition:color .15s var(--ease),background .15s var(--ease)}
  .nav:hover{color:var(--page-strong);background:var(--ink-raised)}
  .nav.on{color:var(--page-strong);background:var(--gold-glow);border-color:var(--gold-soft)}
  .nav .lab{flex:1}
  .nav .ct{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--page-muted)}
  .nav.on .ct{color:var(--gold-text)}
  .nav:focus-visible{outline:2px solid var(--gold-text);outline-offset:2px}
  .side .foot{margin-top:auto;padding:14px 8px 0;border-top:1px solid var(--rule-dim);font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;color:var(--page-muted)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--blue);margin-right:7px;box-shadow:0 0 0 0 var(--blue-soft);animation:pulse 2.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 var(--blue-soft)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
  .foot .t{color:var(--page-dim);font-variant-numeric:tabular-nums}
  .foot a{color:var(--page-muted);text-decoration:none;border-bottom:1px solid var(--rule-dim)}
  .foot a:hover{color:var(--gold-text)}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .top{position:sticky;top:0;z-index:4;background:linear-gradient(180deg,var(--ink) 60%,rgba(6,9,15,.86));backdrop-filter:blur(6px);padding:22px 32px 16px;border-bottom:1px solid var(--rule-dim)}
  .ttl{display:flex;align-items:baseline;gap:14px}
  .ttl h2{font-family:var(--serif);font-weight:500;font-size:32px;letter-spacing:-.01em;margin:0;color:var(--page)}
  .ttl .ct{font-family:var(--mono);font-size:12px;color:var(--gold-text);font-variant-numeric:tabular-nums}
  .ttl .sub{font-family:var(--serif);font-weight:300;font-size:16px;color:var(--page-dim);margin-left:auto}
  #q{margin-top:14px;width:100%;background:var(--ink-deep);border:1px solid var(--rule-mid);color:var(--page);padding:11px 14px;border-radius:8px;font-size:16px;font-family:var(--sans);outline:none;transition:border-color .15s}
  #q::placeholder{color:var(--page-faint)}
  #q:focus{border-color:var(--gold-soft);box-shadow:0 0 0 3px var(--gold-glow)}
  .body{padding:24px 32px 90px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
  .card{background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:10px;padding:14px 16px;transition:border-color .15s var(--ease)}
  .card:hover{border-color:var(--rule-strong)}
  .card .n{font-family:var(--mono);font-weight:400;font-size:13px;color:var(--page-strong);letter-spacing:-.01em}
  .card .d{color:var(--page-dim);font-size:13px;margin-top:5px;line-height:1.5}
  .tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.04em;color:var(--page-muted);border:1px solid var(--rule-mid);border-radius:5px;padding:2px 7px;margin-top:9px}
  .tag.plug{color:var(--blue-text);border-color:var(--blue-soft)}
  .rows{display:flex;flex-direction:column;gap:7px}
  .row{background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:8px;padding:10px 14px;font-family:var(--mono);font-size:12.5px;display:flex;gap:12px;align-items:baseline}
  .row .ev{color:var(--gold-text);min-width:104px;letter-spacing:.04em}
  .row .mt{color:var(--blue-text);min-width:92px}
  .row .cmd{color:var(--page-dim);word-break:break-word;line-height:1.5}
  .pill{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;border-radius:20px;padding:2px 9px}
  .pill.on{color:var(--blue-text);border:1px solid var(--blue-soft)}
  .pill.off{color:var(--page-muted);border:1px solid var(--rule-mid)}
  .pill.mask{color:var(--page-muted);border:1px solid var(--rule-mid);text-transform:none;letter-spacing:0}
  .kv{display:flex;flex-wrap:wrap;gap:9px}
  .kv span{background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:7px;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--page)}
  .kv span i{color:var(--gold-text);font-style:normal;margin-right:5px}
  .kvk{background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:7px;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--page-dim);display:inline-flex;align-items:center;gap:6px}
  .kvk i{color:var(--page-strong);font-style:normal}
  .tdot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;vertical-align:middle}
  .tdot.safe{background:var(--blue)} .tdot.caution{background:var(--gold)} .tdot.danger{background:#c98a8a} .tdot.info{background:var(--page-faint)}
  /* settings table */
  .settbl{width:100%;border-collapse:collapse}
  .settbl th{text-align:left;font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--page-muted);font-weight:400;padding:0 14px 9px;border-bottom:1px solid var(--rule-mid)}
  .settbl td{padding:10px 14px;border-bottom:1px solid var(--rule-dim);vertical-align:middle}
  .settbl tr:hover td{background:var(--ink-deep)}
  .settbl .k{font-family:var(--mono);font-size:12.5px;color:var(--page-strong)}
  .settbl .val{font-family:var(--mono);font-size:12.5px;color:var(--page-dim);word-break:break-all}
  .settbl .tlab{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}
  .tlab.safe{color:var(--blue-text)} .tlab.caution{color:var(--gold-text)} .tlab.danger{color:#d0a0a0} .tlab.info{color:var(--page-faint)}
  /* future toggle — rendered, disabled */
  .tog{position:relative;display:inline-block;width:34px;height:18px;border-radius:20px;background:var(--ink-raised-2);border:1px solid var(--rule-mid);flex:none;cursor:not-allowed;opacity:.6}
  .tog.on{background:var(--blue-soft);border-color:var(--blue-soft)}
  .tog:after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--page-muted);transition:left .15s}
  .tog.on:after{left:18px;background:var(--blue-text)}
  .ro{font-family:var(--mono);font-size:11px;color:var(--page-faint)}
  details.perm{margin-top:4px}
  details.perm summary{cursor:pointer;color:var(--blue-text);font-family:var(--mono);font-size:12px;padding:6px 0;list-style:none}
  details.perm summary::-webkit-details-marker{display:none}
  details.perm summary:before{content:"▸ ";color:var(--page-muted)}
  details.perm[open] summary:before{content:"▾ "}
  details.perm .pl-wrap{margin-top:6px;display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto;padding-right:4px}
  .pl{font-family:var(--mono);font-size:11.5px;color:var(--page-muted);background:var(--ink);border:1px solid var(--rule-dim);border-radius:6px;padding:5px 9px;word-break:break-all}
  .hdrlist{color:var(--page-dim);font-family:var(--serif);font-size:15px;line-height:1.85}
  .hdrlist b{color:var(--page);font-weight:400}
  .hdrlist b:after{content:" · ";color:var(--page-faint)}
  .sect-lede{font-family:var(--serif);font-weight:300;font-size:16px;color:var(--page-dim);margin:0 0 18px}
  .hidden{display:none !important}
  .empty{color:var(--page-muted);font-family:var(--serif);font-style:italic;font-size:16px;padding:20px 2px}
  .docbtn{font-family:var(--mono);font-size:12px;color:var(--page);background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:7px;padding:6px 10px;cursor:pointer;transition:border-color .15s}
  .docbtn:hover{border-color:var(--gold-soft)}
  .docbtn i{color:var(--gold-text);font-style:normal;margin-right:5px}
  .memgroup{margin-top:22px}
  .memgroup .gl{font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold-text);margin:0 0 9px}
  .memwrap{display:flex;flex-direction:column;gap:6px}
  .memrow{display:block;width:100%;text-align:left;background:var(--ink-deep);border:1px solid var(--rule-mid);border-radius:8px;padding:10px 14px;cursor:pointer;color:var(--page);font-family:var(--sans);transition:border-color .15s var(--ease)}
  .memrow:hover{border-color:var(--gold-soft)}
  .memrow .mt{font-family:var(--mono);font-size:12.5px;color:var(--page-strong)}
  .memrow .mh{color:var(--page-dim);font-size:13px;display:block;margin-top:3px;line-height:1.45}
  .memrow.ext{cursor:default;opacity:.65}
  .memrow.ext:hover{border-color:var(--rule-mid)}
  .card.read,.row.read{cursor:pointer}
  .card.read:hover{border-color:var(--gold-soft)}
  .row.read:hover{border-color:var(--gold-soft)}
  .scrim{position:fixed;inset:0;background:rgba(6,9,15,.72);backdrop-filter:blur(4px);z-index:30;display:flex;justify-content:center;align-items:flex-start;padding:6vh 4vw}
  .modal{background:var(--ink-raised);border:1px solid var(--rule-mid);border-radius:12px;max-width:880px;width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.5)}
  .modal .mhead{display:flex;align-items:baseline;gap:12px;padding:18px 22px;border-bottom:1px solid var(--rule-dim)}
  .modal .mhead h3{font-family:var(--mono);font-weight:400;font-size:15px;color:var(--page-strong);margin:0;letter-spacing:-.01em}
  .modal .mhead .src{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--page-muted)}
  .modal .mhead .x{margin-left:auto;cursor:pointer;background:none;border:1px solid var(--rule-mid);color:var(--page-dim);border-radius:7px;width:30px;height:30px;font-size:16px;line-height:1;transition:border-color .15s}
  .modal .mhead .x:hover{border-color:var(--gold-soft);color:var(--page)}
  .modal .mbody{padding:20px 24px;overflow:auto;font-family:var(--serif);font-size:15.5px;line-height:1.64;color:var(--page-dim);white-space:pre-wrap;word-break:break-word}
  .modal .mbody strong{color:var(--page);font-weight:500}
  @media(max-width:840px){
    .app{flex-direction:column}
    .side{width:auto;height:auto;position:static;flex-direction:column;gap:10px;padding:18px 20px}
    .side .foot{margin-top:8px}
    nav{flex-direction:row;flex-wrap:wrap;gap:6px}
    .nav{min-height:38px;width:auto;padding:0 12px}
    .top{padding:18px 20px 14px}.body{padding:20px 20px 70px}
  }
</style></head><body>
<div class="app">
  <aside class="side">
    <div class="brand"><div class="ey">Claude Code</div><h1>Config</h1></div>
    <div class="rule"></div>
    <nav id="nav"></nav>
    <div class="foot">
      <div><span class="dot"></span>live · re-scans on view</div>
      <div style="margin-top:6px">scanned <span class="t" id="scanT">—</span></div>
      <div id="rootP" style="margin-top:6px;word-break:break-all;color:var(--page-faint)"></div>
      <div style="margin-top:10px"><a href="https://github.com/SolanceLab" target="_blank" rel="noopener">built by SolanceLab</a></div>
    </div>
  </aside>
  <div class="main">
    <div class="top">
      <div class="ttl"><h2 id="secTtl">Skills</h2><span class="ct" id="secCt"></span><span class="sub" id="secSub"></span></div>
      <input id="q" placeholder="filter this section…" autocomplete="off" spellcheck="false">
    </div>
    <div class="body" id="view"></div>
  </div>
</div>
<script>
const $=(s,r=document)=>r.querySelector(s);
const esc=(s)=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const escA=(s)=>esc(s).replace(/"/g,"&quot;");
let DATA=null, ACTIVE="skills", FILTER="";
const SECTIONS=[
  {id:"skills",label:"Skills",sub:"Capabilities Claude can load on demand."},
  {id:"agents",label:"Agents",sub:"Specialist subagents that can be dispatched."},
  {id:"commands",label:"Commands",sub:"Slash commands, local and plugin-provided."},
  {id:"workflows",label:"Workflows",sub:"Deterministic multi-agent orchestrations."},
  {id:"mcp",label:"MCP",sub:"Connected MCP servers (names + transport; secrets hidden)."},
  {id:"hooks",label:"Hooks",sub:"Shell that fires on harness events."},
  {id:"plugins",label:"Plugins",sub:"Installed plugin packages and what they provide."},
  {id:"marketplaces",label:"Marketplaces",sub:"Sources plugins are installed from."},
  {id:"settings",label:"Settings",sub:"Model, permissions, environment — the full surface."},
  {id:"rules",label:"Rules",sub:"The instructions and memory Claude carries."},
];
const count=(id)=>{ if(!DATA) return 0;
  if(id==="hooks") return DATA.settings.hooks.length;
  if(id==="settings") return DATA.settings.all?DATA.settings.all.length:0;
  if(id==="rules") return DATA.rules.memory.entries;
  if(id==="marketplaces") return (DATA.marketplaces||[]).length;
  return (DATA[id]||[]).length; };
function renderNav(){
  $("#nav").innerHTML=SECTIONS.map(s=>'<button class="nav'+(s.id===ACTIVE?' on':'')+'" onclick="pick(\\''+s.id+'\\')"><span class="lab">'+s.label+'</span><span class="ct">'+count(s.id)+'</span></button>').join("");
}
function pick(id){ ACTIVE=id; FILTER=""; $("#q").value=""; renderNav(); renderView(); window.scrollTo(0,0); }
const cardEl=(it)=>'<div class="card'+(it.doc?' read':'')+'" data-h="'+escA((it.name+" "+(it.description||"")+" "+(it.source||"")).toLowerCase())+'"'
  +(it.doc?' data-doc="'+it.doc+'" data-title="'+escA(it.name)+'" data-src="'+escA(it.source||"")+'"':'')+'>'
  +'<div class="n">'+esc(it.name)+'</div>'
  +(it.description?'<div class="d">'+esc(it.description)+'</div>':'')
  +(it.source?'<span class="tag'+(it.source.startsWith("plugin")?' plug':'')+'">'+esc(it.source)+'</span>':'')+'</div>';
function renderView(){
  const sec=SECTIONS.find(s=>s.id===ACTIVE);
  $("#secTtl").textContent=sec.label; $("#secCt").textContent=count(ACTIVE); $("#secSub").textContent=sec.sub;
  const v=$("#view");
  if(["skills","agents","commands","workflows"].includes(ACTIVE)){
    const items=DATA[ACTIVE]||[];
    v.innerHTML=items.length?'<div class="grid">'+items.map(cardEl).join("")+'</div>':'<div class="empty">Nothing here yet.</div>';
  } else if(ACTIVE==="hooks"){
    const h=DATA.settings.hooks;
    v.innerHTML=h.length?'<div class="rows">'+h.map(x=>'<div class="row read" data-h="'+escA((x.event+" "+x.matcher+" "+x.command).toLowerCase())+'" data-cmd="'+escA(x.commandFull||x.command)+'" data-title="'+escA(x.event+" · "+x.matcher)+'" data-src="hook">'
      +'<span class="ev">'+esc(x.event)+'</span><span class="mt">'+esc(x.matcher)+'</span><span class="cmd">'+esc(x.command)+'</span></div>').join("")+'</div>':'<div class="empty">No hooks configured.</div>';
  } else if(ACTIVE==="plugins"){
    v.innerHTML=DATA.plugins.length?'<div class="grid">'+DATA.plugins.map(p=>'<div class="card'+(p.doc?' read':'')+'" data-h="'+escA(p.id.toLowerCase())+'"'+(p.doc?' data-doc="'+p.doc+'" data-title="'+escA(p.id)+'" data-src="plugin"':'')+'>'
      +'<div class="n">'+esc(p.id)+' <span class="pill '+(p.enabled?'on':'off')+'">'+(p.enabled?'enabled':'disabled')+'</span></div>'
      +'<div class="d">v'+esc(p.version)+' · '+esc(p.scope)+' · '+p.provides.skills+' skills · '+p.provides.commands+' cmds · '+p.provides.agents+' agents</div></div>').join("")+'</div>':'<div class="empty">No plugins installed.</div>';
  } else if(ACTIVE==="mcp"){
    v.innerHTML=DATA.mcp.length?'<div class="grid">'+DATA.mcp.map(m=>'<div class="card" data-h="'+escA((m.name+" "+m.type+" "+m.detail).toLowerCase())+'">'
      +'<div class="n">'+esc(m.name)+' <span class="pill on">'+esc(m.type)+'</span>'+(m.scope==="project"?' <span class="pill off">project</span>':'')+'</div>'
      +(m.detail?'<div class="d">'+esc(m.detail)+'</div>':'')
      +(m.envKeys.length?'<span class="tag">env: '+m.envKeys.map(esc).join(", ")+' (masked)</span>':'')+'</div>').join("")+'</div>':'<div class="empty">No MCP servers configured in ~/.claude.json.</div>';
  } else if(ACTIVE==="marketplaces"){
    v.innerHTML=DATA.marketplaces.length?'<div class="grid">'+DATA.marketplaces.map(m=>'<div class="card" data-h="'+escA((m.name+" "+m.source).toLowerCase())+'">'
      +'<div class="n">'+esc(m.name)+'</div>'+(m.source?'<div class="d">'+esc(m.source)+'</div>':'')+'</div>').join("")+'</div>':'<div class="empty">No marketplaces registered.</div>';
  } else if(ACTIVE==="settings"){
    const s=DATA.settings;
    const perm=(label,arr)=>arr.length?'<details class="perm"><summary>'+label+' ('+arr.length+')</summary><div class="pl-wrap">'+arr.map(x=>'<div class="pl" data-h="'+escA(x.toLowerCase())+'">'+esc(x)+'</div>').join("")+'</div></details>':'';
    const TLAB={safe:"safe",caution:"caution",danger:"danger",info:"other"};
    const rowFor=(k)=>{
      const isBool=k.type==="bool";
      const on=isBool&&k.value==="true";
      const ctrl=isBool?'<span class="tog'+(on?' on':'')+'" title="editing coming soon — read-only"></span>':'<span class="ro">—</span>';
      const valCell=k.set?'<span class="val">'+esc(k.value)+'</span>':'<span class="val" style="opacity:.45">'+esc(k.value)+'</span> <span class="ro">default</span>';
      return '<tr data-h="'+escA(k.key.toLowerCase())+'"><td><span class="tdot '+k.tier+'" title="'+k.tier+'"></span></td><td class="k">'+esc(k.key)+'</td><td>'+valCell+'</td><td><span class="tlab '+k.tier+'">'+(TLAB[k.tier]||k.tier)+'</span></td><td>'+ctrl+'</td></tr>';
    };
    const setN=(s.all||[]).filter(k=>k.set).length;
    const table='<table class="settbl"><thead><tr><th></th><th>Setting</th><th>Value</th><th>Tier</th><th>Toggle</th></tr></thead><tbody>'+(s.all||[]).map(rowFor).join("")+'</tbody></table>';
    v.innerHTML='<div class="rows">'
      +'<div class="kv"><span><i>model</i>'+esc(s.model)+'</span><span><i>effort</i>'+esc(s.effortLevel)+'</span><span><i>mode</i>'+esc(s.defaultMode)+'</span><span><i>editor</i>'+esc(s.editorMode)+'</span><span><i>local settings</i>'+(s.hasLocalSettings?'yes':'no')+'</span></div>'
      +'<p class="sect-lede" style="margin:20px 0 10px">All settings <span class="ro">— '+setN+' set · '+(s.all||[]).length+' known · toggles read-only (editing coming soon)</span></p>'
      +table
      +'<p class="sect-lede" style="margin:22px 0 8px">Environment</p>'
      +'<div class="kv">'+(s.envKeys.length?s.envKeys.map(k=>'<span><i>env</i>'+esc(k)+' <span class="pill mask">value masked</span></span>').join(""):'<span>no env vars</span>')+'</div>'
      +(s.additionalDirectories.length?'<div class="kv" style="margin-top:10px">'+s.additionalDirectories.map(d=>'<span><i>dir</i>'+esc(d)+'</span>').join("")+'</div>':'')
      +'<p class="sect-lede" style="margin:22px 0 8px">Permissions</p>'
      +'<div>'+perm("allow",s.permissions.allow)+perm("deny",s.permissions.deny)+perm("ask",s.permissions.ask)+'</div></div>';
  } else if(ACTIVE==="rules"){
    const r=DATA.rules;
    const groups=[]; const byG={};
    (r.memory.items||[]).forEach(m=>{ if(!byG[m.group]){byG[m.group]=[];groups.push(m.group);} byG[m.group].push(m); });
    const memHtml=groups.map(g=>'<div class="memgroup">'+(g?'<p class="gl">'+esc(g)+'</p>':'')
      +'<div class="memwrap">'+byG[g].map(m=>{
        const dh=escA((m.title+' '+m.hook).toLowerCase());
        if(m.readable&&m.doc) return '<button class="memrow" data-h="'+dh+'" data-doc="'+m.doc+'" data-title="'+escA(m.title)+'" data-src="memory"><span class="mt">'+esc(m.title)+'</span>'+(m.hook?'<span class="mh">'+esc(m.hook)+'</span>':'')+'</button>';
        return '<div data-h="'+dh+'" class="memrow ext"><span class="mt">'+esc(m.title)+'</span><span class="mh">'+esc(m.hook||m.file)+'</span></div>';
      }).join("")+'</div></div>').join("");
    v.innerHTML='<div class="rows">'
      +'<div class="kv">'
        +(r.claudeMd.doc?'<button class="docbtn" data-doc="'+r.claudeMd.doc+'" data-title="CLAUDE.md" data-src="rules"><i>CLAUDE.md</i>'+Math.round(r.claudeMd.bytes/1024)+' KB · read</button>':'<span><i>CLAUDE.md</i>none</span>')
        +'<span><i>MEMORY.md</i>'+(r.memory.exists?r.memory.entries+' indexed':'none found')+'</span></div>'
      +(r.claudeMd.headers.length?'<p class="sect-lede" style="margin:18px 0 6px">CLAUDE.md sections</p><div class="hdrlist">'+r.claudeMd.headers.map(h=>'<b>'+esc(h)+'</b>').join("")+'</div>':'')
      +(r.memory.entries?'<p class="sect-lede" style="margin:24px 0 2px">Memory — click any entry to read it</p>'+memHtml:'<p class="empty">No memory index found under ~/.claude/projects/*/memory/.</p>')
      +'</div>';
  }
  applyFilter();
}
function applyFilter(){
  const f=FILTER.trim().toLowerCase();
  $("#view").querySelectorAll("[data-h]").forEach(n=>n.classList.toggle("hidden", f && !n.getAttribute("data-h").includes(f)));
}
$("#q").addEventListener("input",e=>{FILTER=e.target.value;applyFilter();});
function mdLite(t){ t=(t||"").replace(/^---[\\s\\S]*?\\n---\\n?/, ""); return esc(t.trim()).replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>"); }
function showModal(title, src){
  const scrim=document.createElement("div"); scrim.className="scrim";
  scrim.innerHTML='<div class="modal"><div class="mhead"><h3>'+esc(title)+'</h3>'+(src?'<span class="src">'+esc(src)+'</span>':'')+'<button class="x" aria-label="Close">×</button></div><div class="mbody"></div></div>';
  scrim.addEventListener("click",e=>{ if(e.target===scrim||e.target.classList.contains("x")) scrim.remove(); });
  const onKey=e=>{ if(e.key==="Escape"){ scrim.remove(); document.removeEventListener("keydown",onKey); } };
  document.addEventListener("keydown",onKey);
  document.body.appendChild(scrim);
  return scrim.querySelector(".mbody");
}
async function openDoc(id, title, src){
  const mb=showModal(title, src); mb.textContent="reading…";
  try{ const d=await (await fetch("/api/doc?id="+id)).json(); mb.innerHTML=d.error?"(couldn't read — refresh the page and retry)":mdLite(d.text); }
  catch(e){ mb.textContent="(read failed)"; }
}
$("#view").addEventListener("click",e=>{
  const d=e.target.closest("[data-doc]"); if(d){ openDoc(+d.dataset.doc, d.dataset.title, d.dataset.src); return; }
  const c=e.target.closest("[data-cmd]"); if(c){ showModal(c.dataset.title, c.dataset.src).textContent=c.dataset.cmd; }
});
function sig(x){return x?JSON.stringify(SECTIONS.map(s=>count(s.id))):"";}
async function poll(){
  try{ const r=await fetch("/api/data");const d=await r.json();
    const before=sig(DATA);DATA=d;
    $("#scanT").textContent=new Date(d.scannedAt).toLocaleTimeString(); $("#rootP").textContent=d.root;
    if(before!==sig(DATA)){ renderNav(); renderView(); }
  }catch(e){ $("#scanT").textContent="offline"; }
}
(async()=>{ await poll(); renderNav(); renderView(); setInterval(poll,3000); })();
</script></body></html>`;
