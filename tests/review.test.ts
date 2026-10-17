import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Runs under `claude plugin test .`: the module in Claude Code's own engine,
// with the model, the clock and the store answered from memory.

const PATCH = [{
  oldStart: 40, oldLines: 4, newStart: 40, newLines: 3,
  lines: [' function login(user) {', '-  if (!user) return null', '   return user.token.value', ' }'],
}]

const WARN = 'WARN: removed the null check in src/auth.ts:41\n- src/auth.ts:41 — user can be undefined — restore the guard'

type World = { lines: (string | undefined)[]; toasts: string[]; prompts: string[]; asked: string[]; settle: () => Promise<void> }

function world(on: On, reply = WARN): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w: World = { lines: [], toasts: [], prompts: [], asked: [], settle: () => clock.settle() }
  mock.store(on)
  on('ui.status', ($, e) => {
    w.lines.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    w.asked.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 2_000, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: '/p/src/auth.ts', structuredPatch: PATCH } }))
  // The engine's own band: an empty box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, null)
  })
  return w
}

const turn = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' } as const

async function editTurn($: any, agentId?: string) {
  await $.turn.start({ text: 'make login faster', turnId: 't1', ...(agentId ? { agentId } : {}) })
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/auth.ts', old_string: 'if (!user) return null\n', new_string: '' })
  await $.turn.complete({ ...turn, ...(agentId ? { agentId } : {}) })
}

test('reviews a turn that changed code and pins the warning', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await editTurn($)
  await w.settle()

  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).toContain('make login faster')
  expect(w.asked[0]).toContain('--- a/src/auth.ts')
  expect(w.asked[0]).toContain('-  if (!user) return null')
  expect(w.lines.at(-1)).toContain('⚠ removed the null check in src/auth.ts:41')
  expect(w.toasts).toEqual(['Second opinion: ⚠ removed the null check in src/auth.ts:41'])

  const details = await $.command.run({ command: 'second-opinion', args: '' })
  expect(details.text).toContain('user can be undefined')

  await $.command.run({ command: 'second-opinion', args: 'fix' })
  await w.settle()
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('restore the guard')
})

test('a clean turn gets a check mark and no toast', async ($, on) => {
  const w = world(on, 'OK: dropped an unused import')
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await editTurn($)
  await w.settle()
  expect(w.lines.at(-1)).toContain('✓ dropped an unused import')
  expect(w.toasts).toEqual([])
})

test('no code change, no review', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what does login do?', turnId: 't1' })
  await $.turn.complete(turn)
  await w.settle()
  expect(w.asked.length).toBe(0)
})

test('/second-opinion off stops the reviews', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'second-opinion', args: 'off' })
  expect(off.text).toContain('off')
  await editTurn($)
  await w.settle()
  expect(w.asked.length).toBe(0)
})

test("a subagent's turn end waits for the main turn", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await editTurn($, 'a1')
  await w.settle()
  expect(w.asked.length).toBe(0)
  await $.turn.complete(turn)
  await w.settle()
  expect(w.asked.length).toBe(1)
})

test('the band shows the warning, opens the details, and hands them to Claude', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await editTurn($)
  await w.settle()

  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as any
  const band = await $.ui.mount({ plugin: 'second-opinion', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await band.find({ text: /removed the null check/ })).toBeDefined()
  expect(await band.find({ text: /restore the guard/ })).toBeUndefined()

  await band.press({ key: 'details' })
  expect(await band.find({ text: /restore the guard/ })).toBeDefined()

  await band.press({ key: 'fix' })
  await w.settle()
  expect(w.prompts.length).toBe(1)

  await band.press({ key: 'dismiss' })
  expect(await band.find({ text: /removed the null check/ })).toBeUndefined()
})
