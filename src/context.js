// Recent-conversation context. Most real prompts are follow-ups ("fix all of it"), so the
// router needs the last few turns, not just the current line.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export const RECENT_USER_TURNS = 3;
export const MAX_TURN_CHARS = 400;
export const MAX_ASSISTANT_CHARS = 700;

/** Read the last `bytes` of a file without loading the whole transcript. */
export function tailLines(path, bytes = 512 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // drop the partial first line
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseEntries(lines) {
  const out = [];
  for (const line of lines) {
    try { const o = JSON.parse(line); if (o && o.type) out.push(o); } catch {}
  }
  return out;
}

/** Prompts that are machine-generated (task notifications, subagent hand-backs, security-review fan-out), not typed by the user. */
export const GENERATED = [/^<task-notification>/, /^Another Claude session sent a message/, /<agent-message/, /^Review this change for security vulnerabilities/];
export const isGenerated = (prompt) => GENERATED.some((re) => re.test(prompt));

export function isUserPrompt(entry) {
  const c = entry.message?.content;
  return entry.type === "user" && typeof c === "string" && !c.trimStart().startsWith("<");
}

export function assistantText(entry) {
  if (entry.type !== "assistant") return "";
  return (entry.message?.content ?? [])
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Build the `recent_conversation` state from transcript entries that precede the current prompt.
 * @param {Array} entries in transcript order
 * @param {string} currentPrompt dropped if it already appears as the last user entry
 */
export function conversationContext(entries, currentPrompt) {
  const users = [];
  let lastAssistant = "";
  for (const e of entries) {
    if (isUserPrompt(e)) users.push(e.message.content.trim());
    else if (e.type === "assistant") { const t = assistantText(e); if (t) lastAssistant = t; }
  }
  if (users.length && users[users.length - 1] === currentPrompt.trim()) users.pop();
  const previous = users.slice(-RECENT_USER_TURNS).map((u) => clip(u.replace(/\s+/g, " "), MAX_TURN_CHARS));
  if (!previous.length && !lastAssistant) return null;
  const ctx = {};
  if (previous.length) ctx.previous_user_messages = previous;
  if (lastAssistant) ctx.last_assistant_message = clip(lastAssistant.replace(/\s+/g, " "), MAX_ASSISTANT_CHARS);
  return ctx;
}
