import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeFrom, toDiff, stats, buildPrompt, parseVerdict, costUsd, money, statusLine, detailsText, fixPrompt, relPath,
} from '../src/core.js';

const PATCH = [{
  oldStart: 40, oldLines: 4, newStart: 40, newLines: 3,
  lines: [' function login(user) {', '-  if (!user) return null', '   return user.token.value', ' }'],
}];

describe('changes', () => {
  it('reads the structured patch of an Edit or Write result', () => {
    const c = changeFrom('Edit', { file_path: '/p/src/auth.ts' }, { structuredPatch: PATCH });
    assert.equal(c.file, '/p/src/auth.ts');
    assert.equal(c.hunks[0].newStart, 40);
    assert.equal(c.hunks[0].lines[1], '-  if (!user) return null');
  });

  it('skips a change with no added or removed line', () => {
    const same = [{ oldStart: 1, newStart: 1, lines: [' a', ' b'] }];
    assert.equal(changeFrom('Edit', { file_path: '/p/a' }, { structuredPatch: same }), null);
    assert.equal(changeFrom('Edit', {}, { structuredPatch: PATCH }), null);
  });

  it('falls back to the call input when the result has no patch', () => {
    assert.deepEqual(changeFrom('Write', { file_path: '/p/new.ts', content: 'a\nb' }, {}).hunks[0].lines, ['+a', '+b']);
    assert.deepEqual(changeFrom('Edit', { file_path: '/p/x', old_string: 'a', new_string: 'b' }, {}).hunks[0].lines, ['-a', '+b']);
    assert.deepEqual(changeFrom('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'x = 1' }, {}).hunks[0].lines, ['+x = 1']);
  });
});

describe('diff and prompt', () => {
  const change = { file: '/p/src/auth.ts', hunks: PATCH };

  it('writes a unified diff with project-relative paths and line numbers', () => {
    const d = toDiff([change], { cwd: '/p' });
    assert.match(d, /^--- a\/src\/auth\.ts\n\+\+\+ b\/src\/auth\.ts\n@@ -40 \+40 @@\n/);
    assert.match(d, /-  if \(!user\) return null/);
  });

  it('cuts a long diff and says how much was left out', () => {
    const big = { file: '/p/big.ts', hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 2000 }, (_, i) => `+line ${i}`) }] };
    const d = toDiff([change, big, big], { cwd: '/p', max: 5000 });
    assert.ok(d.length < 5300, `diff was ${d.length} chars`);
    assert.match(d, /2 more file changes not shown/);
  });

  it('counts files and changed lines', () => {
    assert.deepEqual(stats([change, change]), { files: 1, lines: 2 });
  });

  it("puts the user's request ahead of the diff", () => {
    const p = buildPrompt([change], { request: 'make login faster', cwd: '/p' });
    assert.ok(p.indexOf('make login faster') < p.indexOf('--- a/src/auth.ts'));
    assert.doesNotMatch(buildPrompt([change], { cwd: '/p' }), /The user asked/);
  });

  it('keeps paths outside the project absolute', () => {
    assert.equal(relPath('/p/src/a.ts', '/p'), 'src/a.ts');
    assert.equal(relPath('/elsewhere/a.ts', '/p'), '/elsewhere/a.ts');
    assert.equal(relPath('/pp/a.ts', '/p'), '/pp/a.ts');
  });
});

describe('verdict', () => {
  it('reads a warning with its details', () => {
    const v = parseVerdict('WARN: removed the null check in src/auth.ts:41\n- src/auth.ts:41 — user can be undefined — restore the guard\n- extra');
    assert.equal(v.ok, false);
    assert.equal(v.line, 'removed the null check in src/auth.ts:41');
    assert.deepEqual(v.details, ['src/auth.ts:41 — user can be undefined — restore the guard', 'extra']);
  });

  it('reads an OK, case-insensitively, after a stray preamble', () => {
    assert.deepEqual(parseVerdict('Here is my review.\nok: renamed a helper'), { ok: true, line: 'renamed a helper', details: [] });
  });

  it('never invents a warning from an off-format reply', () => {
    assert.equal(parseVerdict('I think this looks risky').ok, true);
    assert.equal(parseVerdict('').ok, true);
  });
});

describe('cost and display', () => {
  it('prices a Haiku review in fractions of a cent', () => {
    const usd = costUsd({ input_tokens: 5_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.ok(usd > 0 && usd < 0.001, `cost ${usd}`);
    assert.ok(costUsd({ input_tokens: 5_000, output_tokens: 200 }, 'sonnet') > usd * 10);
    assert.equal(costUsd(undefined), 0);
  });

  it('formats money for small amounts', () => {
    assert.equal(money(0), '$0');
    assert.equal(money(0.0006), '$0.0006');
    assert.equal(money(0.12), '$0.12');
  });

  it('pins a short line under the prompt', () => {
    assert.equal(statusLine({ off: true, last: null }), undefined);
    assert.equal(statusLine({ reviewing: '2 files' }), 'reviewing 2 files…');
    assert.equal(statusLine({ last: { ok: true, line: 'renamed a helper' }, spent: 0 }), '✓ renamed a helper');
    assert.equal(statusLine({ last: { ok: false, line: 'removed a check' }, spent: 0.0021 }), '⚠ removed a check · /second-opinion · $0.0021 so far');
  });

  it('spells out a review and the ask for a fix', () => {
    const v = { ok: false, line: 'removed a check', details: ['a.ts:3 — x — y'], files: 1, lines: 2, model: 'haiku', cost: 0.0004 };
    assert.match(detailsText(v), /⚠ removed a check\n  - a\.ts:3 — x — y\n  1 file, 2 changed lines · haiku · \$0\.0004/);
    assert.match(detailsText(null), /No review yet/);
    assert.match(fixPrompt(v), /- a\.ts:3 — x — y/);
    assert.match(fixPrompt(v), /If it is, fix it/);
  });
});

describe('plugin layout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8');

  it('wires the module through hooks.json', () => {
    assert.deepEqual(JSON.parse(read('hooks/hooks.json')), { modules: ['./review.tsx'] });
    assert.ok(existsSync(new URL('../hooks/review.tsx', import.meta.url)));
  });

  it('reads no files, runs no processes and talks to no server of its own', () => {
    const mod = read('hooks/review.tsx') + read('src/core.js');
    assert.doesNotMatch(mod, /\$\.(fs|process)\b|fetch\(|process\.env/);
  });

  it('keeps manifest and marketplace in step', () => {
    const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    const pkg = JSON.parse(read('package.json'));
    assert.equal(market.plugins[0].name, plugin.name);
    assert.equal(pkg.version, plugin.version);
  });
});
