#!/usr/bin/env node
// Claude Code UserPromptSubmit hook. Reads the hook JSON on stdin, asks Jev which
// skills fit the prompt, prints additionalContext. Never blocks or fails the prompt.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, projectContext } from "./catalog.js";
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
  const prompt = (input.prompt ?? "").trim();
  if (!prompt || prompt.startsWith("/") || prompt.length < 6) return null;
  const cwd = input.cwd || process.cwd();
  const catalog = buildCatalog({ cwd });
  if (!catalog.length) return null;
  const recent = input.transcript_path ? conversationContext(parseEntries(tailLines(input.transcript_path)), prompt) : null;
  const { picks, gate, usage, ms } = await route({ prompt, catalog, context: projectContext(cwd), recent });
  const sel = selectPicks(picks, gate);
  log({
    session_id: input.session_id, cwd, prompt: prompt.slice(0, 300), ms, input_tokens: usage.input_tokens, had_recent: !!recent, gate: +gate.toFixed(2),
    top: picks.slice(0, 8).map((s) => [s.qualified, +s.p.toFixed(2)]),
    invoke: sel.invoke.map((s) => s.qualified), mention: sel.mention.map((s) => s.qualified),
  });
  return formatContext(sel);
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
  process.exit(0);
}
