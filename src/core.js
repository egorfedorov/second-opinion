/**
 * Second Opinion — the pure part.
 *
 * hooks/review.ts collects the code changes of one Claude Code turn and asks
 * a cheap model to review them. This file turns those changes into a diff,
 * the diff into a prompt, and the model's reply into a verdict. No imports
 * and no I/O, so it runs in the mod's sandbox and under Node's tests alike.
 */

/** Haiku 5.5 list prices, US dollars per million tokens. */
export const PRICES = {
  haiku: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** A diff past this many characters is cut, file by file, before review. */
export const MAX_DIFF_CHARS = 24_000;

export const SYSTEM_PROMPT = [
  'You review one turn of changes an AI coding agent just made, as a strict but fair senior engineer.',
  'Report only problems that would hurt: bugs, a removed check or error handling, a security hole,',
  'data loss, a broken contract with callers, logic that does not do what the user asked, leftover',
  'debug code, a committed secret. Ignore style, naming, formatting, missing tests, and anything the',
  'diff does not show. When nothing is wrong, say so; never invent a problem.',
  '',
  'Answer in exactly this format:',
  'Line 1: "OK: <what changed, at most 12 words>" or',
  '        "WARN: <the most important problem, at most 14 words, with file:line>"',
  'Then, only after WARN, at most 4 lines: "- <file:line> — <problem> — <fix>"',
].join('\n');

/** A path relative to the project, when it is inside it. */
export function relPath(file, cwd) {
  if (!file) return '?';
  if (cwd && file.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) return file.slice(cwd.replace(/\/$/, '').length + 1);
  return file;
}

/**
 * One change from a finished tool call, or null when there is nothing to
 * review. Edit and Write results carry `structuredPatch`: hunks with line
 * numbers and `+`/`-`/` ` lines, which is what the review cites.
 * @param {string} tool
 * @param {any} input
 * @param {any} result
 * @returns {{ file: string, hunks: { oldStart: number, newStart: number, lines: string[] }[] } | null}
 */
export function changeFrom(tool, input, result) {
  const file = input?.file_path || input?.notebook_path || result?.filePath;
  if (!file) return null;
  const patch = result?.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    const hunks = patch
      .map(h => ({ oldStart: h.oldStart, newStart: h.newStart, lines: (h.lines || []).map(String) }))
      .filter(h => h.lines.some(l => l.startsWith('+') || l.startsWith('-')));
    return hunks.length ? { file, hunks } : null;
  }
  // No patch in the result: fall back to what the call asked for.
  if (tool === 'Write' && typeof input.content === 'string') {
    return { file, hunks: [{ oldStart: 0, newStart: 1, lines: input.content.split('\n').map(l => `+${l}`) }] };
  }
  if (tool === 'NotebookEdit' && typeof input.new_source === 'string') {
    return { file, hunks: [{ oldStart: 0, newStart: 1, lines: input.new_source.split('\n').map(l => `+${l}`) }] };
  }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const lines = [...input.old_string.split('\n').map(l => `-${l}`), ...input.new_string.split('\n').map(l => `+${l}`)];
    return { file, hunks: [{ oldStart: 0, newStart: 0, lines }] };
  }
  return null;
}

/** The changes as one unified diff, cut to `max` characters a file at a time. */
export function toDiff(changes, { cwd = '', max = MAX_DIFF_CHARS } = {}) {
  const parts = [];
  let used = 0;
  let cut = 0;
  for (const c of changes) {
    const name = relPath(c.file, cwd);
    const body = c.hunks.map(h =>
      `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`).join('\n');
    const text = `--- a/${name}\n+++ b/${name}\n${body}`;
    if (used + text.length > max) {
      const room = max - used;
      if (room > 400) parts.push(`${text.slice(0, room)}\n… (cut)`);
      cut++;
      used = max;
      continue;
    }
    parts.push(text);
    used += text.length;
  }
  if (cut) parts.push(`(${cut} more file change${cut > 1 ? 's' : ''} not shown: the diff was too long)`);
  return parts.join('\n');
}

/** Files and changed lines, for the status line. */
export function stats(changes) {
  const files = new Set(changes.map(c => c.file));
  let lines = 0;
  for (const c of changes) for (const h of c.hunks) for (const l of h.lines) if (/^[+-]/.test(l)) lines++;
  return { files: files.size, lines };
}

/** The user message sent to the reviewer. */
export function buildPrompt(changes, { request = '', cwd = '' } = {}) {
  const ask = request.trim() ? `The user asked the agent:\n"""\n${request.trim().slice(0, 1200)}\n"""\n\n` : '';
  return `${ask}The agent's changes in this turn:\n\n${toDiff(changes, { cwd })}`;
}

/**
 * The reviewer's reply as a verdict.
 * @param {string} text
 * @returns {{ ok: boolean, line: string, details: string[] }}
 */
export function parseVerdict(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const head = lines.find(l => /^(OK|WARN)\s*:/i.test(l));
  if (!head) {
    // An off-format reply: never claim a problem the model didn't name.
    return { ok: true, line: 'reviewed; no clear verdict', details: [] };
  }
  const ok = /^OK/i.test(head);
  const line = head.replace(/^(OK|WARN)\s*:\s*/i, '').slice(0, 160);
  const details = ok ? [] : lines.filter(l => l.startsWith('- ')).slice(0, 4).map(l => l.slice(2));
  return { ok, line, details };
}

/** What a review cost, from the API's usage, in US dollars. */
export function costUsd(usage, model = 'haiku') {
  const p = PRICES[model] || PRICES.haiku;
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * p.input
    + (usage.output_tokens || 0) * p.output
    + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}

export function money(usd) {
  if (!(usd > 0)) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The pinned line under the prompt. */
export function statusLine(state) {
  if (state.off) return undefined;
  if (state.reviewing) return `reviewing ${state.reviewing}…`;
  const v = state.last;
  if (!v) return undefined;
  const spent = state.spent > 0 ? ` · ${money(state.spent)} so far` : '';
  return v.ok ? `✓ ${v.line}${spent}` : `⚠ ${v.line} · /second-opinion${spent}`;
}

/** The full review, for `/second-opinion` and the Details button. */
export function detailsText(v) {
  if (!v) return 'No review yet. One runs after the next turn that changes code.';
  const head = v.ok ? `✓ ${v.line}` : `⚠ ${v.line}`;
  const body = v.details.length ? `\n${v.details.map(d => `  - ${d}`).join('\n')}` : '';
  return `${head}${body}\n  ${v.files} file${v.files === 1 ? '' : 's'}, ${v.lines} changed line${v.lines === 1 ? '' : 's'} · ${v.model} · ${money(v.cost)}`;
}

/** The message sent to Claude when the person asks it to act on a warning. */
export function fixPrompt(v) {
  const list = v.details.length ? v.details.map(d => `- ${d}`).join('\n') : `- ${v.line}`;
  return `A second review of your last changes flagged this:\n${list}\n\nCheck whether it is real. If it is, fix it; if not, say why in one line.`;
}
