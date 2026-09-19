#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { buildCatalog, projectContext, readJson } from "./catalog.js";
import { route, selectPicks, formatContext, band, DATA_DIR, BANDS } from "./route.js";
import { runEval, projectsDir } from "./eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "hook.js").replace(/\\/g, "/");
const HOOK_CMD = `node "${HOOK_PATH}"`;
const SETTINGS = join(homedir(), ".claude", "settings.json");

const [, , cmd = "help", ...rest] = process.argv;
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { const k = rest[i].slice(2); const v = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i]; flags[k] = v; }
  else args.push(rest[i]);
}
const cwd = resolve(flags.cwd ?? process.cwd());

const commands = {
  async catalog() {
    const c = buildCatalog({ cwd });
    for (const s of c) console.log(`${s.qualified.padEnd(48)} ${s.source.padEnd(40)} ${s.description.slice(0, 70)}`);
    console.log(`\n${c.length} skills`);
  },

  async route() {
    const prompt = args.join(" ");
    if (!prompt) throw new Error('usage: jev-skill-router route "your prompt" [--cwd dir] [--json]');
    const catalog = buildCatalog({ cwd });
    const { picks, gate, usage, ms } = await route({ prompt, catalog, context: projectContext(cwd) });
    if (flags.json) return console.log(JSON.stringify({ gate, picks: picks.slice(0, 10), usage, ms }, null, 2));
    console.log(`gate (is this a request?) ${Math.round(gate * 100)}%`);
    for (const s of picks.slice(0, 10)) console.log(`${String(Math.round(s.p * 100)).padStart(3)}%  ${band(s.p).padEnd(8)} ${s.qualified}`);
    console.log(`\n${catalog.length} skills, ${usage.input_tokens} input tokens, ${ms} ms`);
    const text = formatContext(selectPicks(picks, gate));
    console.log(text ? `\n--- injected context ---\n${text}` : "\n(nothing would be injected)");
  },

  // "eval" here is the CLI subcommand name (transcript replay), not JavaScript eval().
  async eval() {
    const dirs = args.length ? args.map((a) => resolve(a)) : [projectsDir()].flatMap((root) =>
      existsSync(root) ? readJsonDirs(root) : []);
    const limit = Number(flags.limit ?? 100);
    const threshold = Number(flags.threshold ?? BANDS.invoke);
    const out = await runEval({ dirs, limit, threshold, seed: Number(flags.seed ?? 1), noRecent: !!flags["no-recent"], onTurn: (r, n, total) => {
      if (!flags.quiet) process.stderr.write(`\r${n}/${total}`);
    } });
    process.stderr.write("\n");
    mkdirSync(DATA_DIR, { recursive: true });
    const file = flags.out ?? join(DATA_DIR, `eval-${Date.now()}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out.summary, null, 2));
    console.log(`cost ≈ $${(out.input_tokens / 1e6 * 0.042).toFixed(4)} for ${out.evaluated} turns (${out.input_tokens} Jev input tokens)`);
    console.log(`full results: ${file}`);
    if (flags.show) {
      console.log("\nTurns where Claude invoked nothing but the router picked something:");
      for (const r of out.results.filter((r) => !r.error && !r.invoked.length && r.picked.length).slice(0, Number(flags.show) || 15))
        console.log(`  [${r.picked.join(", ")}]  ${r.prompt.slice(0, 110).replace(/\s+/g, " ")}`);
      console.log("\nTurns where Claude invoked a skill:");
      for (const r of out.results.filter((r) => r.invoked?.length))
        console.log(`  claude=[${r.invoked.join(", ")}] router=[${r.picked.join(", ")}] top=${JSON.stringify(r.top.slice(0, 3))}  ${r.prompt.slice(0, 80).replace(/\s+/g, " ")}`);
    }
  },

  async config() {
    mkdirSync(DATA_DIR, { recursive: true });
    const p = join(DATA_DIR, "config.json");
    const cfg = readJson(p);
    if (flags["api-key"]) { cfg.apiKey = flags["api-key"]; writeFileSync(p, JSON.stringify(cfg, null, 2)); console.log(`saved api key to ${p}`); }
    else console.log(`config: ${p}\napiKey: ${cfg.apiKey ? "set" : "not set"} (env TYPESAFE_API_KEY ${process.env.TYPESAFE_API_KEY ? "set" : "not set"})`);
  },

  async install() {
    const settings = readJson(SETTINGS);
    settings.hooks ??= {};
    const list = (settings.hooks.UserPromptSubmit ??= []);
    const already = list.some((g) => g.hooks?.some((h) => String(h.command).includes("jev-skill-router")));
    if (already) return console.log("hook already installed in", SETTINGS);
    list.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 15 }] });
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    console.log(`installed UserPromptSubmit hook in ${SETTINGS}:\n  ${HOOK_CMD}\nRestart Claude Code to activate.`);
  },

  async uninstall() {
    const settings = readJson(SETTINGS);
    const list = settings.hooks?.UserPromptSubmit ?? [];
    const kept = list.filter((g) => !g.hooks?.some((h) => String(h.command).includes("jev-skill-router")));
    if (kept.length === list.length) return console.log("hook not installed");
    if (kept.length) settings.hooks.UserPromptSubmit = kept; else delete settings.hooks.UserPromptSubmit;
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    console.log("hook removed from", SETTINGS);
  },

  async log() {
    const p = join(DATA_DIR, "log.jsonl");
    if (!existsSync(p)) return console.log("no log yet:", p);
    const lines = readFileSync(p, "utf8").trim().split("\n").slice(-Number(flags.n ?? 20));
    for (const l of lines) {
      const e = JSON.parse(l);
      if (e.error) { console.log(`${e.ts}  ERROR ${e.error}`); continue; }
      console.log(`${e.ts}  ${e.ms}ms  invoke=[${e.invoke.join(",")}] mention=[${e.mention.join(",")}]  ${e.prompt.slice(0, 70).replace(/\s+/g, " ")}`);
    }
  },

  async help() {
    console.log(`jev-skill-router <command>

  catalog [--cwd dir]                 list the skills the router can see for a project
  route "prompt" [--cwd dir] [--json] score every skill against a prompt
  eval [transcriptDir...] [--limit N] [--threshold P] [--show N] [--no-recent]
                                      replay real transcripts, compare picks vs Claude's Skill calls
  config --api-key KEY                store the TypeSafe key (or set TYPESAFE_API_KEY)
  install | uninstall                 add/remove the UserPromptSubmit hook in ~/.claude/settings.json
  log [--n 20]                        tail the hook log (${join(DATA_DIR, "log.jsonl")})`);
  },
};

function readJsonDirs(root) {
  return readdirSync(root).map((n) => join(root, n));
}

try {
  if (!commands[cmd]) throw new Error(`unknown command: ${cmd}`);
  await commands[cmd]();
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
