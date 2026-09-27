#!/usr/bin/env node
// Claude Code UserPromptSubmit hook. Reads the hook JSON on stdin, asks Jev which
// skills fit the prompt, prints additionalContext. Never blocks or fails the prompt.
// In shadow mode (config.json "mode": "shadow") it still routes and logs but prints nothing.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, projectContext, readJson } from "./catalog.js";
import { route, selectPicks, formatContext, DATA_DIR } from "./route.js";
import { tailLines, parseEntries, conversationContext } from "./context.js";

function log(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

export async function runHook(input) {
  if (process.env.JEV_SKILL_ROUTER_SKIP) return null; // set by `judge`, which runs claude -p itself
  const prompt = (input.prompt ?? "").trim();
  if (!prompt || prompt.startsWith("/") || prompt.length < 6) return null;
  if (/^\[Image:/.test(prompt)) return null; // pasted screenshot: Jev is text-only, so abstain
  const cwd = input.cwd || process.cwd();
  const catalog = buildCatalog({ cwd });
  if (!catalog.length) return null;
  const recent = input.transcript_path ? conversationContext(parseEntries(tailLines(input.transcript_path)), prompt) : null;
  const { picks, gate, usage, ms } = await route({ prompt, catalog, context: projectContext(cwd), recent });
  const sel = selectPicks(picks, gate);
  const shadow = readJson(join(DATA_DIR, "config.json")).mode === "shadow";
  log({
    session_id: input.session_id, cwd, prompt: prompt.slice(0, 300), ms, input_tokens: usage.input_tokens, recent, gate: +gate.toFixed(2),
    top: picks.slice(0, 8).map((s) => [s.qualified, +s.p.toFixed(2)]),
    invoke: sel.invoke.map((s) => s.qualified), mention: sel.mention.map((s) => s.qualified),
    ...(shadow && { shadow: true }),
  });
  return shadow ? null : formatContext(sel);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  try {
    const input = JSON.parse(await readStdin() || "{}");
    const text = await runHook(input);
    if (text) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
    }
  } catch (err) {
    log({ error: String(err?.message ?? err) });
  }
  // No process.exit(): on Windows, exiting while fetch's background work is still posting
  // tasks trips a libuv assertion (async.c:76) and the nonzero exit drops our output.
  process.exitCode = 0;
}
