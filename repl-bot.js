const mineflayer = require('mineflayer')
const { mineflayer: mineflayerViewer } = require('prismarine-viewer')
const util = require('util')
const readline = require('readline')

let bot = null
let queue = [] // code lines received while disconnected

function connect () {
  const b = mineflayer.createBot({
    host: '127.0.0.1',
    port: 25566,
    username: 'OpBot',
    version: '1.21.1',
    auth: 'offline'
  })
  bot = b

  b.once('spawn', () => {
    console.log('SPAWNED gameMode=' + b.game.gameMode)
    try { mineflayerViewer(b, { port: 3007, firstPerson: false, viewDistance: 6 }) } catch (e) { console.log('viewer err: ' + e.message) }
    const pending = queue; queue = []
    pending.forEach(runLine)
  })
  b.on('game', () => console.log('GAMEMODE now=' + b.game.gameMode))
  b.on('error', (err) => console.error('BOT ERROR:', err.message))
  b.on('kicked', (reason) => console.error('KICKED:', JSON.stringify(reason)))
  b.on('end', () => {
    console.log('disconnected; reconnecting in 3s')
    try { b.viewer && b.viewer.close() } catch (e) {}
    bot = null
    setTimeout(connect, 3000)
  })
}

async function runLine (code) {
  if (!bot) { queue.push(code); console.log('QUEUED (offline): ' + code); return }
  try {
    const fn = new Function('bot', 'mineflayer', 'require', `return (async () => { return (${code}) })()`)
    const result = await fn(bot, mineflayer, require)
    console.log('=> ' + util.inspect(result, { depth: 3, colors: false, maxArrayLength: 20 }))
  } catch (e1) {
    try {
      const fn = new Function('bot', 'mineflayer', 'require', 'code', `return (async () => { return eval(code) })()`)
      const result = await fn(bot, mineflayer, require, code)
      console.log('=> ' + util.inspect(result, { depth: 3, colors: false, maxArrayLength: 20 }))
    } catch (e2) {
      console.log('ERR: ' + (e2.message || e2))
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const code = line.trim()
  if (code) runLine(code)
})

connect()
