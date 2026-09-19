// Ask Jev, in one request, "would this skill help with this prompt?" for every skill in the catalog.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { readJson } from "./catalog.js";
import { join } from "node:path";
import { homedir } from "node:os";

export const DATA_DIR = join(homedir(), ".claude", "jev-skill-router");

/** Probability bands. Calibrate with `jev-skill-router eval`. */
export const BANDS = { invoke: 0.65, mention: 0.45 };
export const MAX_INVOKE = 3;
export const MAX_MENTION = 3;
const MAX_DESC_CHARS = 700;

export function apiKey() {
  return process.env.TYPESAFE_API_KEY || readJson(join(DATA_DIR, "config.json")).apiKey || null;
}

export function makeClient(opts = {}) {
  const key = apiKey();
  if (!key) throw new Error("No TypeSafe API key. Set TYPESAFE_API_KEY or run: jev-skill-router config --api-key <key>");
  return new TypeSafeClient({ apiKey: key, ...opts });
}

/** Extra question: is this a real request, or just "yes", "go for it", "ok continue"? */
export const GATE_KEY = "_is_request";
export const GATE_MIN = 0.4;
export const GATE_STRICT_THRESHOLD = 0.85;

export function buildQuestions(catalog) {
  const questions = {
    [GATE_KEY]: {
      type: "noul",
      instructions: "Does the user's message itself ask for specific work, a change, or information?",
      criteria: {
        true: "It names a task, a question, a bug, a file, a feature, or pastes content to act on.",
        false: "It only acknowledges, agrees, says to continue or start, or chats without naming work.",
      },
    },
  };
  catalog.forEach((s, i) => {
    const desc = s.description.length > MAX_DESC_CHARS ? s.description.slice(0, MAX_DESC_CHARS) + "…" : s.description;
    questions[`s${i}`] = {
      type: "noul",
      instructions: `Would loading the Claude Code skill "${s.qualified}" help with the user's request?\nSkill description: ${desc}`,
      criteria: {
        true: "The request is about what this skill covers, or the description names this kind of request as a trigger.",
        false: "The request is unrelated or only loosely related; loading the skill would not change how the task gets done.",
      },
    };
  });
  return questions;
}

/**
 * @param {{prompt:string, catalog:Array, context?:object, recent?:object|null, client?:TypeSafeClient, signal?:AbortSignal, timeout?:number}} args
 *   context = project signals (deps, markers); recent = previous turns from the transcript
 * @returns {Promise<{picks:Array, usage:object, model:string, ms:number}>}
 */
export async function route({ prompt, catalog, context, recent, client, signal, timeout = 8000 }) {
  client ??= makeClient();
  const state = { user_prompt: prompt };
  if (recent) state.recent_conversation = recent;
  if (context) state.project = context;
  const questions = buildQuestions(catalog);
  const t0 = performance.now();
  const res = await client.systemOne({ state, questions }, { signal, timeout });
  const ms = Math.round(performance.now() - t0);
  const picks = catalog
    .map((s, i) => ({ ...s, p: res.answers[`s${i}`].noul }))
    .sort((a, b) => b.p - a.p);
  return { picks, gate: res.answers[GATE_KEY].noul, usage: res.usage, model: res.model, ms };
}

export function band(p) {
  if (p >= BANDS.invoke) return "invoke";
  if (p >= BANDS.mention) return "mention";
  return "skip";
}

/**
 * When the message is not really a request (gate low), only near-certain matches get through
 * and nothing is merely "mentioned". Stops "yes start" from dragging in five skills.
 */
export function selectPicks(picks, gate = 1) {
  const strict = gate < GATE_MIN;
  const invokeAt = strict ? GATE_STRICT_THRESHOLD : BANDS.invoke;
  const invoke = picks.filter((s) => s.p >= invokeAt).slice(0, MAX_INVOKE);
  const mention = strict ? [] : picks.filter((s) => s.p < BANDS.invoke && s.p >= BANDS.mention).slice(0, MAX_MENTION);
  return { invoke, mention, strict };
}

const pct = (p) => `${Math.round(p * 100)}%`;

/** The text injected into Claude's context. Kept well under the 10k-char hook cap. */
export function formatContext({ invoke, mention }) {
  if (!invoke.length && !mention.length) return null;
  const lines = ["jev-skill-router matched skills to this prompt (number = probability the skill helps):"];
  for (const s of invoke) lines.push(`- ${s.qualified} (${pct(s.p)}): invoke it with the Skill tool before starting.`);
  for (const s of mention) lines.push(`- ${s.qualified} (${pct(s.p)}): possibly relevant, use your judgment.`);
  return lines.join("\n");
}
