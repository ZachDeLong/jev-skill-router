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
   - 0.45 to 0.65 ("mention" band): logged, never injected, because judged mentions were mostly noise
   - if the gate says the message is just "yes" / "go for it": only ≥ 0.85 matches
   - pasted screenshots, task notifications and subagent hand-backs are skipped entirely
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

**Shadow mode:** `node src/cli.js config --mode shadow` keeps routing and logging every prompt but
injects nothing, so you can `judge` Jev's picks before letting them steer Claude. Shadow entries
are marked `"shadow": true` in the log. `--mode live` turns injection back on.

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

## Judge: a second opinion on every pick

`judge` runs each router decision (from the hook log, or from an `eval` results file) through a
headless Claude call (Haiku by default, `--model` for a stronger grader) that sees the prompt,
the recent turns, the picks with their descriptions, and the catalog for that project, and labels
each pick **needed** / **harmless** / **wrong**, plus any catalog skill the router should have picked.
"Did Claude invoke it" is a bad ground truth because Claude almost never does; a grader that
knows what the turn needed is a much better one. About $0.02 per turn with Haiku.

```sh
node src/cli.js judge --from log --limit 40 --show 15
node src/cli.js judge --from ~/.claude/jev-skill-router/eval-<ts>.json
```

First run, 60 firing turns from the eval above (invoke band):

| | needed | harmless | wrong |
| --- | --- | --- | --- |
| all 60 turns | 22 | 22 | 20 |
| excluding 6 screenshot-only prompts | 22 | 20 | 9 |

Eleven of the twenty wrong picks came from prompts that were just a pasted screenshot, which
Jev can't see. The hook now abstains on those. With those gone, 82% of invoke-band picks were
needed or harmless. The "mention" band was mostly noise (6 needed, 50 harmless, 34 wrong), so
treat it as a hint at best. Named misses were almost all
`anthropic-skills:computer-use` on prompts about computer-use agents.

Second run (2026-09-26), 102 firing turns from a week of the hook log, Haiku grader:

| | needed | harmless | wrong |
| --- | --- | --- | --- |
| invoke band, all turns | 41 | 59 | 14 |
| invoke band, 80 typed prompts | 34 | 45 | 6 |
| mention band | 11 | 81 | 39 |

The other 22 turns were task notifications and subagent hand-backs, where most wrong picks came
from; the hook now skips those. `computer-use` fired on 39 turns, but all 12 of its wrong picks
were in the mention band, which is why mentions are no longer injected. Haiku grading from skill
names alone made mistakes of its own (it read `typesafe-ai` as TypeScript), so the judge now
gets each pick's description.

## Caveats

- Built-in skill descriptions are copied by hand into `data/builtin-skills.json` and will drift.
- Jev reads text literally: sarcasm and images (screenshot prompts) are guesses from context.
- The router recommends; Claude still decides. Check `log` to see what was injected.
- Windows paths are handled, but the hook command is written with the absolute path of this
  checkout, so re-run `install` if you move the folder.
