# Changelog

## 0.1.0 — 2026-10-17

First release.

- After every Claude Code turn that changed code, Haiku 5.5 reviews the turn's
  diff with the request you typed, in the background.
- The verdict is pinned under the prompt: `✓ <what changed>` or
  `⚠ <the problem, with file:line>`, plus the session's review spend.
- A warning opens a band above the prompt with **Details**, **Ask Claude to
  fix** and **Dismiss**, and shows a toast.
- `/second-opinion` for the full review; `fix`, `on`, `off`, and
  `model haiku|sonnet`.
- Edits from subagents count; the review waits for the main turn to end.
- Diffs past 24K characters are cut file by file, and the review says so.
