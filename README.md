# jev-skill-router

A `UserPromptSubmit` hook for Claude Code that asks [Jev](https://docs.typesafe.ai) (TypeSafe's
non-generative judgment model) which of your installed skills fit the prompt you just typed, then
tells Claude to load them. One HTTP request per prompt, about 350 ms, about $0.0005.

**Privacy, up front:** every prompt you type, the last three prompts before it, up to 700 characters
of Claude's last reply, and your project's dependency names are sent to TypeSafe's API. Nothing
else (no file contents, no tool output). TypeSafe says inputs are not used for training; their
policy does not state a retention limit. Don't install this on a repo whose prompts you can't share.

## Why

Claude Code lists every installed skill in the system prompt and leaves it to the model to notice
when one applies. Two things I measured on my own machine before writing this:

| What | Number |
| --- | --- |
| Tokens the skill listing costs per session (74 skills) | ~4,400 of ~44,000 |
| Prompts across my transcripts where Claude invoked a skill | 11 of 420 |

So skills are cheap to carry but rarely fire. The router doesn't save context. It makes the
"should I load a skill?" decision explicit, calibrated, and loggable. It also tells you when
your skill descriptions are the problem.

## How it works

1. `catalog.js` finds every skill Claude Code would list: `.claude/skills` in the project, `~/.claude/skills`,
   synced anthropic-skills, each enabled plugin's `skills/` and `commands/`, plus a hand-kept list of
   built-ins (`data/builtin-skills.json`, since those ship inside the binary). Skills with
   `disable-model-invocation: true` are skipped because Claude can't load them anyway.
2. `route.js` sends one request to Jev: state = your prompt + recent turns + project signals,
   questions = one yes/no ("would this skill help?") per skill, plus a gate question ("is this
   message actually a request?"). Jev returns a probability for each.
3. `hook.js` turns the probabilities into `additionalContext`:
   - probability ≥ 0.65: "invoke it with the Skill tool before starting" (max 3)
   - 0.45 to 0.65: "possibly relevant, use your judgment" (max 3)
   - if the gate says the message is just "yes" / "go for it": only ≥ 0.85 matches, no maybes
   Every decision is appended to `~/.claude/jev-skill-router/log.jsonl`. Any failure (no key,
   timeout, bad JSON) exits 0 with no output so your prompt is never blocked.

## Install

```sh
git clone https://github.com/ZachDeLong/jev-skill-router
cd jev-skill-router && npm install
node src/cli.js config --api-key <your TypeSafe key>   # or export TYPESAFE_API_KEY
node src/cli.js install                                # adds the hook to ~/.claude/settings.json
```

Restart Claude Code. `node src/cli.js uninstall` removes the hook.

## Commands

```
node src/cli.js catalog [--cwd dir]        what the router can see for a project
node src/cli.js route "prompt" [--cwd dir] score every skill against one prompt
node src/cli.js eval [--limit N] [--show N] [--no-recent]
                                           replay your real transcripts (see below)
node src/cli.js log [--n 20]               tail the hook log
```

Example:

```
$ node src/cli.js route "why is the deploy failing on vercel, build says module not found" --cwd ../counselor-sophie
gate (is this a request?) 97%
 95%  invoke   vercel:nextjs
 91%  invoke   vercel:deployments-cicd
 83%  invoke   vercel:vercel-cli
 61%  mention  vercel:verification
 ...
74 skills, 11151 input tokens, 322 ms
```

## Eval: replaying your own transcripts

`eval` reads `~/.claude/projects/**/*.jsonl`, samples N user prompts, routes each one with the
same context the hook would have had, and compares against the skills Claude actually invoked in
that turn. 120 prompts cost about $0.06.

The ground truth is weak by construction: Claude rarely invokes skills, so "agreement with Claude"
mostly measures whether the router fires when Claude didn't. Read the `--show` output by hand.
Things it surfaced on my transcripts:

- Pasted Vercel build logs, "spin up a localhost", "was that why my API credits burned so fast",
  and "okay I agree, commit" all got a confident correct pick where Claude loaded nothing.
- Without recent-turn context, follow-ups like "fix all of it and rerun" route to nothing;
  with it, the router fires on 30% of prompts instead of 24%.
- Bare acknowledgments ("Yes start") pulled in five skills before the gate question existed.
  The gate now flags 36 of 120 sampled prompts as not-a-request.
- With a Next.js project in context, `vercel:nextjs` scores high on almost anything, which is
  a description problem as much as a routing one.

## Caveats

- Built-in skill descriptions are copied by hand into `data/builtin-skills.json` and will drift.
- Jev reads text literally: sarcasm and images (screenshot prompts) are guesses from context.
- The router recommends; Claude still decides. Check `log` to see what was injected.
- Windows paths are handled, but the hook command is written with the absolute path of this
  checkout, so re-run `install` if you move the folder.
