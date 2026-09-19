// Replay real Claude Code transcripts: for each user prompt, compare the router's picks
// against the skills Claude actually invoked in that turn.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildCatalog, projectContext } from "./catalog.js";
import { route, makeClient, BANDS, selectPicks } from "./route.js";
import { conversationContext, isUserPrompt } from "./context.js";

export function projectsDir(home = homedir()) {
  return join(home, ".claude", "projects");
}

/** Prompts that are machine-generated (subagent hand-backs, security-review fan-out), not typed by the user. */
const GENERATED = [/^Another Claude session sent a message/, /<agent-message/, /^Review this change for security vulnerabilities/];

/** @returns {Array<{prompt:string, invoked:string[], cwd:string, file:string, recent:object|null}>} */
export function loadTurns(dirs) {
  const turns = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      let cur = null;
      const history = [];
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        const m = o.message ?? {};
        if (o.type === "user" && typeof m.content === "string") {
          const p = m.content.trim();
          const skip = !p || p.startsWith("<") || p.startsWith("/") || p.length < 6 || GENERATED.some((re) => re.test(p));
          if (skip) cur = null;
          else {
            cur = { prompt: p, invoked: [], cwd: o.cwd ?? "", file: f, recent: conversationContext(history, p) };
            turns.push(cur);
          }
          if (isUserPrompt(o)) history.push(o);
        } else if (o.type === "assistant") {
          history.push(o);
          if (!cur) continue;
          for (const c of m.content ?? []) {
            if (c?.type === "tool_use" && c.name === "Skill" && c.input?.skill) cur.invoked.push(c.input.skill);
          }
        }
      }
    }
  }
  return turns;
}

function sample(arr, n, seed = 1) {
  const a = arr.slice();
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

export async function runEval({ dirs, limit = 100, seed = 1, threshold = BANDS.invoke, concurrency = 4, onTurn, noRecent = false }) {
  const flagsNoRecent = noRecent;
  const all = loadTurns(dirs);
  const turns = sample(all, limit, seed);
  const client = makeClient();
  const catalogCache = new Map();
  const results = [];
  let tokens = 0;
  let i = 0;
  async function worker() {
    while (i < turns.length) {
      const t = turns[i++];
      const cwd = t.cwd || process.cwd();
      if (!catalogCache.has(cwd)) catalogCache.set(cwd, { catalog: buildCatalog({ cwd }), context: projectContext(cwd) });
      const { catalog, context } = catalogCache.get(cwd);
      const known = new Set(catalog.map((s) => s.qualified));
      try {
        const { picks, gate, usage } = await route({ prompt: t.prompt, catalog, context, recent: flagsNoRecent ? null : t.recent, client });
        tokens += usage.input_tokens;
        const sel = selectPicks(picks, gate);
        const r = {
          prompt: t.prompt.slice(0, 200),
          invoked: [...new Set(t.invoked)],
          invoked_known: [...new Set(t.invoked)].filter((s) => known.has(s)),
          gate: +gate.toFixed(2),
          top: picks.slice(0, 5).map((s) => [s.qualified, +s.p.toFixed(2)]),
          picked: sel.invoke.map((s) => s.qualified),
          mentioned: sel.mention.map((s) => s.qualified),
        };
        results.push(r);
        onTurn?.(r, results.length, turns.length);
      } catch (err) {
        results.push({ prompt: t.prompt.slice(0, 200), error: String(err?.message ?? err) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, total_turns: all.length, evaluated: results.length, input_tokens: tokens, threshold, summary: summarize(results, threshold) };
}

export function summarize(results, threshold) {
  const ok = results.filter((r) => !r.error);
  let tp = 0, fp = 0, fn = 0;
  const withTruth = ok.filter((r) => r.invoked_known.length);
  for (const r of withTruth) {
    const P = new Set(r.picked), T = new Set(r.invoked_known);
    for (const s of P) T.has(s) ? tp++ : fp++;
    for (const s of T) if (!P.has(s)) fn++;
  }
  const silentButPicked = ok.filter((r) => !r.invoked.length && r.picked.length);
  const gated = ok.filter((r) => r.gate < 0.4).length;
  return {
    turns: ok.length,
    turns_where_claude_invoked_a_skill: ok.filter((r) => r.invoked.length).length,
    turns_with_catalog_truth: withTruth.length,
    recall_on_truth: withTruth.length ? +(tp / (tp + fn)).toFixed(2) : null,
    precision_on_truth: tp + fp ? +(tp / (tp + fp)).toFixed(2) : null,
    router_fires_rate: +(ok.filter((r) => r.picked.length).length / ok.length).toFixed(2),
    turns_gated_as_not_a_request: gated,
    silent_claude_but_router_picked: silentButPicked.length,
    threshold,
  };
}
