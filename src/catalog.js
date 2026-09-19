// Discover every skill Claude Code would list for a session: project, personal,
// synced (anthropic-skills), enabled plugins, and a hand-maintained list of built-ins.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let key = null, block = null, buf = [];
  const flush = () => {
    if (key && block) out[key] = buf.join(block === ">" ? " " : "\n").trim();
    key = null; block = null; buf = [];
  };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      flush();
      const [, k, v] = kv;
      if (/^[>|]-?$/.test(v)) { key = k; block = v[0]; }
      else out[k] = unquote(v);
    } else if (key) buf.push(line.trim());
  }
  flush();
  return out;
}

function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function readJson(p, fallback = {}) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function scanSkillDir(dir, source, prefix, add) {
  if (!isDir(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "SKILL.md");
    if (existsSync(file)) add(file, source, prefix);
  }
}

/** Older plugins ship slash commands as commands/<name>.md; Claude Code lists them as skills too. */
function scanCommandDir(dir, source, prefix, add) {
  if (!isDir(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) add(join(dir, name), source, prefix, name.slice(0, -3));
  }
}

function enabledPlugins(cwd, home) {
  const merged = {};
  for (const p of [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) Object.assign(merged, readJson(p).enabledPlugins ?? {});
  return Object.entries(merged).filter(([, on]) => on).map(([id]) => id);
}

function pluginInstallPath(id, cwd, home) {
  const entries = readJson(join(home, ".claude", "plugins", "installed_plugins.json")).plugins?.[id] ?? [];
  const norm = (p) => resolve(p).toLowerCase();
  const project = entries.find((e) => e.scope === "project" && e.projectPath && norm(e.projectPath) === norm(cwd));
  const user = entries.find((e) => e.scope === "user");
  return (project ?? user ?? entries[0])?.installPath;
}

/**
 * @returns {Array<{name:string, qualified:string, description:string, path:string|null, source:string}>}
 */
export function buildCatalog({ cwd = process.cwd(), home = homedir(), includeBuiltins = true } = {}) {
  const skills = [];
  const seen = new Set();
  const add = (file, source, prefix, fallbackName) => {
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    fm.name ??= fallbackName;
    if (!fm.name || !fm.description) return;
    if (String(fm["disable-model-invocation"]).toLowerCase() === "true") return;
    const qualified = prefix ? `${prefix}:${fm.name}` : fm.name;
    if (seen.has(qualified)) return;
    seen.add(qualified);
    skills.push({ name: fm.name, qualified, description: fm.description.replace(/\s+/g, " ").trim(), path: file, source });
  };

  scanSkillDir(join(cwd, ".claude", "skills"), "project", null, add);

  const personal = join(home, ".claude", "skills");
  if (existsSync(personal)) {
    for (const name of readdirSync(personal)) {
      if (name === "synced") continue;
      const file = join(personal, name, "SKILL.md");
      if (existsSync(file)) add(file, "user", null);
    }
    const synced = join(personal, "synced");
    if (existsSync(synced)) {
      for (const bundle of readdirSync(synced)) {
        const dir = join(synced, bundle);
        if (!isDir(dir)) continue;
        const manifest = readJson(join(dir, "manifest.json"));
        const prefix = manifest.name ?? manifest.plugin ?? "anthropic-skills";
        scanSkillDir(dir, "synced", prefix, add);
      }
    }
  }

  for (const id of enabledPlugins(cwd, home)) {
    const installPath = pluginInstallPath(id, cwd, home);
    if (!installPath) continue;
    scanSkillDir(join(installPath, "skills"), `plugin:${id}`, id.split("@")[0], add);
    scanCommandDir(join(installPath, "commands"), `plugin:${id}`, id.split("@")[0], add);
  }

  if (includeBuiltins) {
    for (const b of readJson(join(HERE, "..", "data", "builtin-skills.json"), [])) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      skills.push({ name: b.name, qualified: b.name, description: b.description, path: null, source: "builtin" });
    }
  }
  return skills;
}

/** Small project signals that help Jev tell "nextjs question" from "generic question". */
export function projectContext(cwd) {
  const pkg = readJson(join(cwd, "package.json"), null);
  const ctx = { directory: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd };
  if (pkg) {
    ctx.package_name = pkg.name;
    ctx.dependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 60);
  }
  for (const marker of ["pyproject.toml", "Cargo.toml", "go.mod", "vercel.json", "supabase", "next.config.js", "next.config.ts", "next.config.mjs"]) {
    if (existsSync(join(cwd, marker))) (ctx.markers ??= []).push(marker);
  }
  return ctx;
}
