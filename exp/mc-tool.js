// mc-tool.js — eval-kernel helper: serialized REPL bridge to the opbot process.
// Load after kernel reset with:  eval(read('/content/mc-world-exp/exp/mc-tool.js'))
// Defines globals: mcRaw, mcSerialized, mcTool, mcTranscript.
// Usage: const r = await mcRaw('w.status()')  ->  {result, events}
//        subagents get the 'mc' tool (same path, transcript-recorded).

globalThis.mcConsumed = ''
globalThis.mcTranscript = []
globalThis.mcBusy = Promise.resolve()

globalThis.mcPoll = async function mcPoll(timeoutS) {
  const res = await tool.hub({ op: 'logs', name: 'opbot', follow: true, cursor: 0, timeout: timeoutS })
  const text = res.text.replace(/\s*\[[^\]]*cursor=\d+[^\]]*\]\s*$/, '')
  const tail = mcConsumed.slice(-300)
  let fresh = ''
  if (tail.length === 0) fresh = text
  else {
    let found = -1
    for (let k = tail.length; k >= 20; k--) {
      const idx = text.lastIndexOf(tail.slice(-k))
      if (idx >= 0) { found = idx + k; break }
    }
    fresh = found >= 0 ? text.slice(found) : text
  }
  mcConsumed = (mcConsumed + fresh).slice(-4000)
  return fresh
}

globalThis.mcRaw = async function mcRaw(code, timeoutMs = 120000) {
  await mcPoll(1)
  await tool.hub({ op: 'send', name: 'opbot', text: code })
  let out = ''
  const events = []
  const deadline = Date.now() + timeoutMs
  let sawEcho = false, sawResult = false
  while (Date.now() < deadline) {
    const fresh = await mcPoll(sawResult ? 2 : 15)
    for (const line of fresh.split('\n')) {
      if (line.startsWith('EVENT')) { events.push(line); continue }
      if (!sawEcho && line.trim() === code.trim()) { sawEcho = true; continue }
      if (sawEcho) out += line + '\n'
    }
    if (/^=> |^ERR:|^QUEUED/m.test(out)) {
      if (sawResult) break
      sawResult = true
    } else if (sawResult) break
  }
  const lines = out.split('\n').filter(l => l !== '')
  return { result: lines.join('\n').trim(), events }
}

// serialized wrapper — concurrent callers queue instead of racing the log buffer
globalThis.mcSerialized = function mcSerialized(code, timeoutMs) {
  const run = mcBusy.then(() => mcRaw(code, timeoutMs))
  mcBusy = run.then(() => {}, () => {})
  return run
}

globalThis.mcTool = tool(async function mc(args) {
  const code = typeof args === 'string' ? args : args.code
  const t0 = Date.now()
  const r = await mcSerialized(code, 120000)
  mcTranscript.push({ t: Date.now(), ms: Date.now() - t0, code, result: r.result, events: r.events })
  let out = r.result
  if (r.events.length) out += '\n' + r.events.join('\n')
  return out || '(no output)'
}, {
  name: 'mc',
  description: 'Execute one line of async JS in the Minecraft bot REPL. Returns the => result or ERR. Globals in scope: bot (mineflayer), w (world.js queries), s (skills.js), s2 (schem.js), require. Lines starting EVENT are pushed world events. Long actions (w.go) may take up to 2min.',
  parameters: { type: 'object', properties: { code: { type: 'string', description: 'JS expression or statement to eval' } }, required: ['code'] }
})
