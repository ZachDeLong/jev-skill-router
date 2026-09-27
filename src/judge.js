// Second opinion on the router's picks: a headless Claude call labels each pick as
// needed / harmless / wrong and names skills the router missed. Gives per-skill precision
// that "did Claude invoke it" ground truth can't.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { DATA_DIR } from "./route.js";
import { isGenerated } from "./context.js";

export const SKIP_ENV = "JEV_SKILL_ROUTER_SKIP";
const LABELS = ["needed", "harmless", "wrong"];
const MAX_DESC_CHARS = 300;

/** Load decisions from the hook log, or from an eval results file. */
export function loadDecisions(source) {
  if (source === "log") {
    const p = join(DATA_DIR, "log.jsonl");
    if (!existsSync(p)) return [];
    // Older entries include task notifications and subagent hand-backs, which the hook now skips.
    return readFileSync(p, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && !e.error && !isGenerated(e.prompt) && (e.invoke?.length || e.mention?.length))
      .map((e) => ({ prompt: e.prompt, recent: e.recent ?? null, cwd: e.cwd, top: e.top, invoke: e.invoke, mention: e.mention }));
  }
  const data = JSON.parse(readFileSync(source, "utf8"));
  return (data.results ?? []).filter((r) => !r.error && (r.picked?.length || r.mentioned?.length))
    .map((r) => ({ prompt: r.prompt, recent: r.recent ?? null, cwd: r.cwd ?? "", top: r.top, invoke: r.picked, mention: r.mentioned ?? [] }));
}

function runClaude(prompt, { model = "haiku", timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", model, "--output-format", "json", "--max-turns", "1", "--disable-slash-commands", "--strict-mcp-config"], {
      env: { ...process.env, [SKIP_ENV]: "1" }, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("judge timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const o = JSON.parse(out);
        resolve({ text: o.result ?? "", cost: o.total_cost_usd ?? 0 });
      } catch { reject(new Error(`bad claude output: ${(err || out).slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in judge reply: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

/** @param catalog skills visible from the decision's cwd; recommended ones get their description so the grader isn't guessing from names */
export function judgePrompt(d, catalog) {
  const byName = new Map(catalog.map((s) => [s.qualified, s]));
  const describe = (name) => {
    const desc = byName.get(name)?.description?.replace(/\s+/g, " ");
    return desc ? `: ${desc.length > MAX_DESC_CHARS ? desc.slice(0, MAX_DESC_CHARS) + "…" : desc}` : "";
  };
  const catalogNames = catalog.map((s) => s.qualified);
  const candidates = [...d.invoke.map((s) => `${s} (router: invoke)${describe(s)}`), ...d.mention.map((s) => `${s} (router: mention)${describe(s)}`)];
  return `You are grading a skill router for Claude Code. The router read a user's prompt and recommended skills to load.
Judge each recommendation from the point of view of the assistant that must now handle this prompt.

Labels:
- needed: loading this skill would clearly improve how the assistant handles this exact turn
- harmless: related but the assistant would do fine without it
- wrong: unrelated, or the message is not a request at all

Also list any skill from the catalog that should have been recommended and wasn't (empty list if none).

USER PROMPT:
${d.prompt}

RECENT CONVERSATION (may be empty):
${d.recent ? JSON.stringify(d.recent, null, 1) : "(none)"}

ROUTER RECOMMENDATIONS:
${candidates.map((c) => "- " + c).join("\n")}

CATALOG (skill names only):
${catalogNames.join(", ")}

Reply with only JSON, no prose, shaped exactly like:
{"picks": {"<skill>": "needed|harmless|wrong", ...}, "missing": ["<skill>", ...], "note": "<one short sentence>"}`;
}

export async function runJudge({ source = "log", limit = 40, model = "haiku", concurrency = 3, onTurn }) {
  const decisions = loadDecisions(source).slice(-limit);
  // The catalog depends on the project (project skills, plugins enabled there), so build it per decision cwd.
  const catalogs = new Map();
  const catalogFor = (cwd) => {
    const key = cwd || process.cwd();
    if (!catalogs.has(key)) catalogs.set(key, buildCatalog({ cwd: key }));
    return catalogs.get(key);
  };
  const results = [];
  let cost = 0, i = 0;
  async function worker() {
    while (i < decisions.length) {
      const d = decisions[i++];
      try {
        const catalog = catalogFor(d.cwd);
        const catalogNames = catalog.map((s) => s.qualified);
        const { text, cost: c } = await runClaude(judgePrompt(d, catalog), { model });
        cost += c;
        const j = extractJson(text);
        const picks = {};
        for (const s of [...d.invoke, ...d.mention]) picks[s] = LABELS.includes(j.picks?.[s]) ? j.picks[s] : "unlabeled";
        results.push({ prompt: d.prompt, invoke: d.invoke, mention: d.mention, picks, missing: (j.missing ?? []).filter((s) => catalogNames.includes(s)), note: j.note ?? "" });
      } catch (err) {
        results.push({ prompt: d.prompt, error: String(err?.message ?? err) });
      }
      onTurn?.(results.length, decisions.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, judged: results.filter((r) => !r.error).length, cost, model, summary: summarize(results) };
}

export function summarize(results) {
  const ok = results.filter((r) => !r.error);
  const perSkill = {};
  const band = { invoke: { needed: 0, harmless: 0, wrong: 0 }, mention: { needed: 0, harmless: 0, wrong: 0 } };
  for (const r of ok) {
    for (const [s, label] of Object.entries(r.picks)) {
      if (!(label in band.invoke)) continue;
      const b = r.invoke.includes(s) ? "invoke" : "mention";
      band[b][label]++;
      (perSkill[s] ??= { needed: 0, harmless: 0, wrong: 0, missed: 0 })[label]++;
    }
    for (const s of r.missing) (perSkill[s] ??= { needed: 0, harmless: 0, wrong: 0, missed: 0 }).missed++;
  }
  const inv = band.invoke;
  return {
    turns: ok.length,
    invoke_band: { ...inv, precision_strict: inv.needed + inv.harmless + inv.wrong ? +(inv.needed / (inv.needed + inv.harmless + inv.wrong)).toFixed(2) : null, not_wrong: inv.needed + inv.wrong ? +((inv.needed + inv.harmless) / (inv.needed + inv.harmless + inv.wrong)).toFixed(2) : null },
    mention_band: band.mention,
    turns_with_a_miss: ok.filter((r) => r.missing.length).length,
    per_skill: Object.fromEntries(Object.entries(perSkill).sort((a, b) => (b[1].needed + b[1].harmless + b[1].wrong + b[1].missed) - (a[1].needed + a[1].harmless + a[1].wrong + a[1].missed))),
  };
}
