# Second Opinion

**Every Claude Code turn gets a second look.** After each turn that changed
code, Haiku 5.5 reads the diff in the background and pins one line under your
prompt: ✓ when nothing broke, ⚠ when something did. The details are one click
away, and one more click hands them to Claude to fix. A review costs about a
tenth of a cent.

```text
second-opinion: ⚠ removed the null check in src/auth.ts:41 · /second-opinion · $0.0009 so far
```

Coding agents are fast and confident, and the mistakes that slip through are
the quiet ones: a guard deleted while "simplifying", an error swallowed, a
function that now does something other than what you asked. You don't read
every diff. Second Opinion does, every turn, with a model 40× cheaper than
Opus that only has to answer one question: did this change break something?

[Landing page](https://egorfedorov.github.io/second-opinion/) ·
[Changelog](CHANGELOG.md) · MIT

---

## How it works

1. **Claude edits.** Second Opinion records every successful `Edit`, `Write`
   and `NotebookEdit` in the turn, including those made by subagents, as the
   diff Claude Code itself produced, with line numbers.
2. **Haiku reviews.** When the turn ends, the diff goes to Haiku 5.5 together
   with what you asked for, so "does something other than the request" counts
   as a problem too. The review runs in the background; you keep working.
3. **One line, then your call.** The verdict is pinned under the prompt. A
   warning also opens a band above the prompt with three buttons:
   **Details**, **Ask Claude to fix**, and **Dismiss**.

```text
⚠ Second opinion: removed the null check in src/auth.ts:41
  - src/auth.ts:41 — user can be undefined here — restore the guard
[Hide]  [Ask Claude to fix]  [Dismiss]
```

## What it flags, and what it leaves alone

| Flags | Leaves alone |
|---|---|
| A removed check, guard or error handling | Style, naming, formatting |
| A bug the diff introduces | Missing tests |
| A broken contract with callers | Anything the diff doesn't show |
| A security hole or a committed secret | Matters of taste |
| Data loss | |
| Leftover debug code | |
| Logic that doesn't do what you asked | |

The reviewer is told to never invent a problem. A reply it can't parse
counts as "no clear verdict", never as a warning.

## Cost

Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output.

| Turn | Diff sent | Review costs |
|---|---|---|
| A one-function fix | ~2K tokens | ~$0.0003 |
| A typical feature turn | ~6K tokens | ~$0.0008 |
| A big refactor (diff cut at 24K characters) | ~8K tokens | ~$0.001 |

A hundred reviewed turns cost about ten cents. The running total for the
session is in the line itself. Want deeper reviews?
`/second-opinion model sonnet` uses Sonnet 5.5 at about twenty times the
price.

## Commands

| Command | What it does |
|---|---|
| `/second-opinion` | The last review in full: every finding, files, lines, model, cost |
| `/second-opinion fix` | Sends the findings to Claude: "check whether it is real, fix it if so" |
| `/second-opinion off` · `on` | Stops and resumes the reviews; remembered across sessions |
| `/second-opinion model haiku` · `sonnet` | Picks the reviewing model |

## Install

In Claude Code:

```bash
claude plugin marketplace add egorfedorov/second-opinion
claude plugin install second-opinion@second-opinion
```

Or, with the other plugins by the same author:

```bash
claude plugin marketplace add egorfedorov/claude-plugins
claude plugin install second-opinion@egorfedorov-plugins
```

Restart Claude Code. The first review appears after the next turn that
changes code.

### Requirements

- Claude Code with plugin mods: the hooks module API that draws the line and
  the band. Recent versions have it.
- Nothing else: no Node, no Python, no API key. The review runs on your
  Claude Code session's own connection.

## Privacy

- The turn's diff, and the request you typed for that turn, go to Claude
  through **your own Claude Code session**, to the same provider and under
  the same account your session already uses. Nothing goes anywhere else.
- It reads no files and runs no commands. The diff comes from the tool
  results Claude Code already has.
- It reads no environment variables and stores only two settings, on/off and
  the model, in Claude Code's own plugin store.

## FAQ

**Does it slow Claude down?**
No. The review starts after the turn has ended and runs in the background.
The next turn doesn't wait for it.

**What if a review is wrong?**
Press **Dismiss**, or ask Claude: **Ask Claude to fix** tells it to check
whether the finding is real before changing anything.

**Why Haiku and not the model I'm coding with?**
A narrow question, "did this diff break something?", doesn't need the
expensive model. Haiku answers it in a second or two for a fraction of a
cent, so it can run on every turn. For a careful pass, switch to Sonnet.

**Does it review changes I make myself?**
No, only what Claude's tools changed in the turn.

## Development

```bash
npm test               # the review logic, under Node
npm run test:engine    # the module in Claude Code's own engine (claude plugin test)
npm run validate       # claude plugin validate
```

The logic is in `src/core.js` (pure, no I/O). The module is
`hooks/review.tsx`, and its state contract is `types/index.d.ts`.

## More by the same author

- [context-optimizer](https://github.com/egorfedorov/claude-context-optimizer):
  a live line with context, cost, plan limits and the cache countdown, plus
  Haiku subagents for the reading.
- [project-brain](https://github.com/egorfedorov/project-brain): a living
  project dossier for claude.ai chat, Cowork and Claude Code.

## License

MIT
