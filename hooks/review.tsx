import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import {
  buildPrompt, changeFrom, costUsd, detailsText, fixPrompt, parseVerdict, stats, statusLine, SYSTEM_PROMPT,
} from '../src/core.js'

// Second Opinion: after every turn that changed code, a cheap model reviews
// the turn's diff in the background and pins a one-line verdict under the
// prompt. A warning also shows in the band above the prompt, with the
// details a click away and a button that hands them to Claude.
//
// The diff goes to the model through this Claude Code session's own client,
// the provider the session already talks to. Nothing else leaves the machine.

const last = atom({ plugin: 'second-opinion', key: 'last' } as const, null)
const isDismissed = atom({ plugin: 'second-opinion', key: 'isDismissed' } as const, false)
const isExpanded = atom({ plugin: 'second-opinion', key: 'isExpanded' } as const, false)

const OFF_KEY = 'off'
const MODEL_KEY = 'model'
const MODELS = new Set(['haiku', 'sonnet'])

type Change = NonNullable<ReturnType<typeof changeFrom>>

type Opinion = {
  changes: Change[]
  request: string
  cwd: string
  model: string
  off: boolean
  spent: number
  reviewing: string
  last: Review | null
  queue: Promise<void>
}

async function review($: EngineInterface, o: Opinion, changes: Change[], request: string) {
  const s = stats(changes)
  o.reviewing = `${s.files} file${s.files === 1 ? '' : 's'}`
  $.ui.status(statusLine(o))

  const r = await $.model.complete({
    model: o.model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(changes, { request, cwd: o.cwd }),
    maxTokens: 500,
    effort: 'low',
    timeoutMs: 90_000,
  })
  o.reviewing = ''
  const cost = costUsd(r.usage, o.model)
  o.spent += cost

  if (!r.isAnswered) {
    $.ui.status(`couldn't review the last turn (${r.reason})`)
    return
  }
  const v = parseVerdict(r.text)
  const done: Review = { ...v, files: s.files, lines: s.lines, model: o.model, cost, at: await $.clock.now() }
  o.last = done
  await update($, last, () => done)
  await update($, isDismissed, () => false)
  await update($, isExpanded, () => false)
  $.ui.status(statusLine(o))
  if (!done.ok) $.ui.toast(`Second opinion: ⚠ ${done.line}`)
}

async function showStatus($: EngineInterface, o: Opinion) {
  $.ui.status(statusLine(o))
}

export const register: Register = on => {
  const o: Opinion = {
    changes: [],
    request: '',
    cwd: '',
    model: 'haiku',
    off: false,
    spent: 0,
    reviewing: '',
    last: null,
    queue: Promise.resolve(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    o.cwd = e.cwd
    o.off = (await $.store.get(OFF_KEY)) === true
    const model = await $.store.get(MODEL_KEY)
    if (typeof model === 'string' && MODELS.has(model)) o.model = model
    await $.command.register({
      name: 'second-opinion',
      description: 'Second Opinion: the last review; on, off, fix, or model haiku|sonnet',
      argumentHint: '[on|off|fix|model haiku|sonnet]',
      immediate: true,
    })
    await showStatus($, o)
    return result
  })

  on('command.run', { command: 'second-opinion' }, async ($, e) => {
    const [word, arg] = (e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (word === 'off' || word === 'on') {
      o.off = word === 'off'
      await $.store.set(OFF_KEY, o.off)
      await showStatus($, o)
      return { text: o.off ? 'Second opinion off. /second-opinion on turns it back on.' : 'Second opinion on: the next turn that changes code gets a review.' }
    }
    if (word === 'model') {
      if (!MODELS.has(arg)) return { text: `Model is ${o.model}. Use /second-opinion model haiku or /second-opinion model sonnet.` }
      o.model = arg
      await $.store.set(MODEL_KEY, arg)
      return { text: `Reviews now run on ${arg}.` }
    }
    if (word === 'fix') {
      if (!o.last || o.last.ok) return { text: 'Nothing to fix: the last review found no problem.' }
      const ask = fixPrompt(o.last)
      // A prompt can't be submitted from inside the command that is running:
      // send it the moment the command is done.
      $.clock.after(0, () => {
        $.prompt.submit({ text: ask }).catch(() => {})
      })
      return { text: 'Sending the findings to Claude.' }
    }
    return { text: detailsText(o.last) }
  })

  // The person's request, so the review can tell "does what was asked" apart
  // from "does something else". Main-thread turns only.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) o.request = e.text
    return next(e)
  })

  // Every successful edit, subagents' included: they change the code too.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const change = changeFrom(e.tool, e, ran.result)
      if (change) o.changes.push(change)
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a slip here must never cost the tool call

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || o.off || o.changes.length === 0) return result
    const changes = o.changes
    const request = o.request
    o.changes = []
    // Off the turn's own dispatch, one review at a time.
    $.clock.after(0, () => {
      o.queue = o.queue.then(() => review($, o, changes, request)).catch(() => {
        o.reviewing = ''
      })
    })
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, last)
    if (e.props.hasSurvey || !v || v.ok || (await read($, isDismissed))) return next(e)
    const open = await read($, isExpanded)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">⚠ Second opinion: </Text>
          <Text>{v.line} </Text>
        </Box>
        {open ? v.details.map((d, i) => <Text key={`d${i}`} dimColor>  - {d}</Text>) : null}
        <Box>
          <Button key="details" label={open ? 'Hide' : 'Details'} onPress={() => update($, isExpanded, x => !x)} />
          <Text> </Text>
          <Button key="fix" label="Ask Claude to fix" onPress={() => $.prompt.submit({ text: fixPrompt(v) })} />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" onPress={() => update($, isDismissed, () => true)} />
        </Box>
      </Box>
    )
  })
}
