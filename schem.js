// schem.js — Sponge .schem (v2) loader + placer.
// s2 = require('/tmp/mc-exp/schem.js')(bot)
// const sc = s2.load('/tmp/foo.schem'); s2.place(sc, x, y, z)
//
// Sponge format: gzip NBT. BlockData = varint array, index = (y*L + z)*W + x.
// Palette maps "minecraft:name[state=v,...]" -> palette id.

const nbt = require('prismarine-nbt')
const fs = require('fs')

module.exports = function schem (bot) {
  async function load (file) {
    const raw = fs.readFileSync(file)
    const parsed = await nbt.parse(raw)
    const v = parsed.parsed.value
    const W = v.Width.value, H = v.Height.value, L = v.Length.value
    const pal = v.Palette.value
    const idToName = {}
    for (const [k, id] of Object.entries(pal)) idToName[id.value] = k
    const data = v.BlockData.value
    // varint decode
    const ids = []
    let i = 0
    while (i < data.length) {
      let val = 0, shift = 0, b
      do { b = data[i++]; val |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
      ids.push(val)
    }
    const cells = []
    for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
      const id = ids[(y * L + z) * W + x]
      const name = idToName[id]
      if (!name || name === 'minecraft:air') continue
      cells.push({ x, y, z, name })
    }
    return { W, H, L, cells, palette: Object.keys(pal).length }
  }

  // place at world coords (ox,oy,oz) = schem origin corner.
  // opts.rate: commands per tick batch (chat flood safety). opts.dry: count only.
  async function place (sc, ox, oy, oz, opts = {}) {
    const rate = opts.rate || 20
    let sent = 0
    for (const c of sc.cells) {
      if (!opts.dry) bot.chat(`/setblock ${ox + c.x} ${oy + c.y} ${oz + c.z} ${c.name}`)
      sent++
      if (sent % rate === 0 && !opts.dry) await new Promise(r => setTimeout(r, 60))
    }
    return { placed: sent, box: [ox, oy, oz, ox + sc.W - 1, oy + sc.H - 1, oz + sc.L - 1] }
  }

  // summarize palette composition (what materials the schem needs)
  function materials (sc) {
    const counts = {}
    for (const c of sc.cells) {
      const base = c.name.replace(/^minecraft:/, '').replace(/\[.*\]/, '')
      counts[base] = (counts[base] || 0) + 1
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
  }

  return { load, place, materials }
}
