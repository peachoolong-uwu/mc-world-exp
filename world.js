// world.js — compact world-query helpers for the REPL bot.
// Usage in REPL:  w = require('/tmp/mc-exp/world.js')(bot)
// Re-run after reconnect (bot object changes).
//
// Patterns borrowed from numen (pull tools) + cortico (push/pull hybrid):
// - egocentric ASCII affordance grid (numen look_around)
// - connected-component grouping of block finds (numen scan_blocks)
// - compass direction + distance + dy band (both)
// - '?' = unloaded/unknown, never silently treated as air (both)
// - per-name nearest dedup in scans (cortico)

module.exports = function world (bot) {
  const Vec3 = require('vec3')
  const pos = () => bot.entity.position.floored()
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))

  const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
  // compass direction of a delta. MC: -z=north, +x=east
  function compass (dx, dz) {
    if (dx === 0 && dz === 0) return 'here'
    const ang = Math.atan2(dx, -dz) // 0 = north, clockwise
    return DIRS[Math.round(ang / (Math.PI / 4)) & 7]
  }
  function dyBand (dy) { return dy >= 3 ? 'above' : dy <= -3 ? 'below' : 'level' }
  function rel (v, p) {
    p = p || pos()
    const dx = v.x - p.x, dy = v.y - p.y, dz = v.z - p.z
    return {
      x: v.x, y: v.y, z: v.z,
      d: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz)),
      dir: compass(dx, dz), dy: dyBand(dy)
    }
  }

  const passable = b => !b || b.boundingBox === 'empty' ||
    ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(b.name)
  const solid = b => b && b.boundingBox === 'block'

  // --- status: where am I, what state ---
  function biomeName (b) {
    if (!b || !b.biome) return null
    if (b.biome.name) return b.biome.name
    const reg = bot.registry && bot.registry.biomes
    const e = reg && reg[b.biome.id]
    return e ? e.name : 'id:' + b.biome.id
  }
  function status () {
    const p = pos()
    const below = at(p.x, p.y - 1, p.z)
    const here = at(p.x, p.y, p.z)
    return {
      pos: { x: p.x, y: p.y, z: p.z },
      dim: bot.game.dimension,
      time: bot.time.timeOfDay, isDay: bot.time.isDay,
      health: bot.health, food: bot.food, xp: bot.experience && bot.experience.level,
      gameMode: bot.game.gameMode,
      biome: biomeName(here),

      light: here && here.light, skyLight: here && here.skyLight,
      raining: bot.isRaining, facing: facing()
    }
  }

  // --- snapshot: cortico-style pushed narration. One compact text block
  //     covering what a push system would send. For A/B token comparison. ---
  function snapshot (r = 16) {
    const p = pos()
    const st = status()
    const lines = []
    lines.push(`body hp${st.health} food${st.food} ${st.gameMode} on:${st.standingOn || 'air'} light:${st.light}`)

    // entities within r, LOS not required for push (cortico uses audible range)
    const ents = entities(r).slice(0, 12)
    lines.push(`entities(${ents.length}${Object.keys(bot.entities).length - 1 > ents.length ? '+' : ''}): ` +
      (ents.map(e => `${e.name}@${e.dir}${e.d}${e.dy === 'level' ? '' : e.dy}`).join(' ') || 'none'))
    // notable blocks: nearest per name, non-background
    const BACKGROUND = /^(stone|deepslate|dirt|sand|sandstone|grass_block|gravel|andesite|diorite|granite|tuff|netherrack|water|lava|air|cave_air|bedrock|snow|ice|clay|calcite|smooth_basalt|dripstone_block)$/
    const hits = bot.findBlocks({ matching: b => b && !AIR_SET.has(b.name) && !BACKGROUND.test(b.name), maxDistance: r, count: 256 })
    const byName = {}
    for (const v of hits) {
      const b = at(v.x, v.y, v.z)
      if (!b) continue
      const d = Math.round(v.distanceTo(p))
      if (!byName[b.name] || d < byName[b.name].d) byName[b.name] = { v, d }
    }
    const blk = Object.entries(byName).sort((a, b) => a[1].d - b[1].d).slice(0, 12)
      .map(([name, { v, d }]) => `${name}@${compass(v.x - p.x, v.z - p.z)}${d}`)
    lines.push(`blocks: ${blk.join(' ') || 'none'}`)
    const invCounts = inv()
    lines.push(`inv: ${Object.entries(invCounts).map(([k, v]) => `${k}x${v}`).join(' ') || 'empty'}`)
    return lines.join('\n')
  }
  const AIR_SET = new Set(['air', 'cave_air', 'void_air'])

  // --- scan: histogram of block types within radius (cheap overview) ---
  function scan (r = 8, opts = {}) {
    const p = pos()
    const counts = {}
    let unloaded = 0
    const yLo = opts.yLo ?? -r, yHi = opts.yHi ?? r
    for (let dy = yLo; dy <= yHi; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue
          const b = at(p.x + dx, p.y + dy, p.z + dz)
          if (b === null) { unloaded++; continue }
          if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue
          counts[b.name] = (counts[b.name] || 0) + 1
        }
      }
    }
    const out = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
    if (unloaded) out._unloaded = unloaded
    return out
  }

  // --- find: blocks of a type grouped into connected components ---
  // Returns groups like numen scan_blocks: {cells, blocks, nearest, box}
  function find (name, r = 32, count = 200) {
    const p = pos()
    const matching = typeof name === 'function'
      ? name
      : (b) => b && (b.name === name || b.name.includes(name))
    const hits = bot.findBlocks({ matching, maxDistance: r, count })
    return { groups: groupCells(hits), scanned: hits.length, truncated: hits.length >= count }
  }

  // union-find over positions, 3x3x3 (chebyshev<=1) adjacency
  function groupCells (vecs) {
    const parent = vecs.map((_, i) => i)
    const findRoot = i => parent[i] === i ? i : (parent[i] = findRoot(parent[i]))
    const key = v => v.x + ',' + v.y + ',' + v.z
    const idx = new Map(vecs.map((v, i) => [key(v), i]))
    for (let i = 0; i < vecs.length; i++) {
      const v = vecs[i]
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const j = idx.get((v.x + dx) + ',' + (v.y + dy) + ',' + (v.z + dz))
        if (j !== undefined) { const a = findRoot(i), b = findRoot(j); if (a !== b) parent[a] = b }
      }
    }
    const groups = new Map()
    vecs.forEach((v, i) => {
      const r = findRoot(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r).push(v)
    })
    return [...groups.values()].map(cells => {
      const names = {}
      let nearest = null, nd = Infinity
      const box = { x1: Infinity, y1: Infinity, z1: Infinity, x2: -Infinity, y2: -Infinity, z2: -Infinity }
      for (const v of cells) {
        const b = at(v.x, v.y, v.z)
        if (b) names[b.name] = (names[b.name] || 0) + 1
        const d = v.distanceTo(pos())
        if (d < nd) { nd = d; nearest = v }
        box.x1 = Math.min(box.x1, v.x); box.y1 = Math.min(box.y1, v.y); box.z1 = Math.min(box.z1, v.z)
        box.x2 = Math.max(box.x2, v.x); box.y2 = Math.max(box.y2, v.y); box.z2 = Math.max(box.z2, v.z)
      }
      const g = { cells: cells.length, blocks: names, nearest: rel(nearest), box: `${box.x1},${box.y1},${box.z1}..${box.x2},${box.y2},${box.z2}` }
      if (cells.length <= 16) g.positions = cells.map(v => [v.x, v.y, v.z])
      return g
    }).sort((a, b) => a.nearest.d - b.nearest.d)
  }

  // --- entities: nearby entities sorted by distance ---
  function entities (r = 48, filter) {
    const p = bot.entity.position
    return Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(p) <= r)
      .filter(e => !filter || (e.name && e.name.includes(filter)) || (e.username && e.username.includes(filter)))
      .map(e => {
        const dx = e.position.x - p.x, dy = e.position.y - p.y, dz = e.position.z - p.z
        return {
          name: e.name || e.username,
          kind: e.kind || e.entityType,
          d: Math.round(e.position.distanceTo(p)),
          dir: compass(Math.round(dx), Math.round(dz)), dy: dyBand(Math.round(dy)),
          pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) },
          health: e.health,
          heldItem: e.heldItem && e.heldItem.name
        }
      })
      .sort((a, b) => a.d - b.d)
  }

  // --- walk: egocentric affordance grid (numen look_around style) ---
  // '.' flat  '^' up-1  ',' down-1-2  'v' drop>=3  '#' wall
  // '~' water '!' lava  'x' hazard-adjacent  '?' unloaded  '@' you (north up)
  function walk (r = 8) {
    const p = pos()
    const rows = []
    for (let dz = -r; dz <= r; dz++) {
      let row = ''
      for (let dx = -r; dx <= r; dx++) {
        row += (dx === 0 && dz === 0) ? '@' : cellClass(p, dx, dz)
      }
      rows.push(row)
    }
    // hazard inflation: '.' or ',' next to '!' or 'v' becomes 'x'
    const g = rows.map(r2 => r2.split(''))
    for (let z = 0; z <= 2 * r; z++) for (let x = 0; x <= 2 * r; x++) {
      if (g[z][x] !== '.' && g[z][x] !== ',') continue
      outer: for (let az = -1; az <= 1; az++) for (let ax = -1; ax <= 1; ax++) {
        const n = g[z + az] && g[z + az][x + ax]
        if (n === '!' || n === 'v') { g[z][x] = 'x'; break outer }
      }
    }
    return g.map(r2 => r2.join(''))
  }

  function cellClass (p, dx, dz) {
    // standing at level Y: feet Y, head Y+1, floor Y-1. Try Y = p.y+1 down to p.y-6.
    for (let y = p.y + 1; y >= p.y - 6; y--) {
      const feet = at(p.x + dx, y, p.z + dz)
      const head = at(p.x + dx, y + 1, p.z + dz)
      if (feet === null || head === null) return '?'
      if (feet.name === 'lava' || head.name === 'lava') return '!'
      if (feet.name === 'water' || head.name === 'water') return '~'
      if (passable(feet) && passable(head)) {
        const floor = at(p.x + dx, y - 1, p.z + dz)
        if (floor === null) return '?'
        if (solid(floor) || floor.name === 'water' || floor.name === 'lava') {
          const dy = y - p.y
          if (floor.name === 'lava') return '!'
          if (floor.name === 'water') return '~'
          if (dy === 1) return '^'
          if (dy === 0) return '.'
          if (dy >= -2) return ','
          return 'v'
        }
        // floor passable → keep falling
      } else if (y <= p.y) {
        return '#' // blocked at or below own level → wall
      }
      // blocked above own level → keep scanning down (overhang)
    }
    return 'v' // no floor within 6 below → deep drop
  }

  // --- grid: top-block letter map (terrain composition, not affordance) ---
  function grid (r = 8, step = 1) {
    const p = pos()
    const rows = []
    for (let dz = -r; dz <= r; dz += step) {
      let row = ''
      for (let dx = -r; dx <= r; dx += step) {
        if (dx === 0 && dz === 0) { row += '@'; continue }
        let top = null, unknown = false
        for (let y = p.y + 4; y >= p.y - 16; y--) {
          const b = at(p.x + dx, y, p.z + dz)
          if (b === null) { unknown = true; break }
          if (b.name !== 'air' && b.name !== 'cave_air') { top = b; break }
        }
        row += unknown ? '?' : !top ? '.' : top.name === 'water' ? '~' : top.name === 'lava' ? '!' : top.name[0]
      }
      rows.push(row)
    }
    return rows
  }

  // --- column: vertical slice at offset ---
  function column (dx = 0, dz = 0, yLo = -10, yHi = 10) {
    const p = pos()
    const out = []
    for (let dy = yHi; dy >= yLo; dy--) {
      const b = at(p.x + dx, p.y + dy, p.z + dz)
      if (b === null) { out.push({ dy, name: '?' }); continue }
      if (b.name !== 'air' && b.name !== 'cave_air') out.push({ dy, name: b.name })
    }
    return out
  }

  // --- inspect: single block detail (numen inspect_block style) ---
  function inspect (x, y, z) {
    const b = at(x, y, z)
    if (b === null) return { name: '?', note: 'unloaded' }
    const p = pos()
    const d = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2)
    return {
      name: b.name,
      states: b.getProperties ? b.getProperties() : undefined,
      hardness: b.hardness, diggable: b.diggable,
      boundingBox: b.boundingBox,
      light: b.light, skyLight: b.skyLight,
      d: Math.round(d * 10) / 10, inReach: d <= 4.5,
      canSee: safeSee(b)
    }
  }
  function safeSee (b) { try { return bot.canSeeBlock(b) } catch (e) { return null } }

  // --- inv: inventory summary ---
  function inv () {
    const counts = {}
    for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
    return counts
  }

  // --- look: block in crosshair ---
  function look (dist = 8) {
    const b = bot.blockAtCursor ? bot.blockAtCursor(dist) : null
    if (!b) return null
    return { name: b.name, pos: b.position, d: Math.round(b.position.distanceTo(pos())) }
  }

  // ================= ACTIONS =================

  // --- go: pathfind to x,y,z (or within r of it). Resolves on arrival. ---
  async function go (x, y, z, r = 1) {
    const goals = require('mineflayer-pathfinder').goals
    const g = r <= 1 ? new goals.GoalBlock(x, y, z) : new goals.GoalNear(x, y, z, r)
    await bot.pathfinder.goto(g)
    return rel({ x, y, z })
  }

  function stop () { bot.pathfinder.stop(); bot.clearControlStates(); return 'stopped' }

  // --- give: creative-mode item via /give (ops). count default 1 ---
  function give (item, count = 1) {
    bot.chat(`/give OpBot ${item.includes(':') ? item : 'minecraft:' + item} ${count}`)
    return 'given ' + item + ' x' + count
  }

  // --- equip: move named inventory item to hand ---
  async function equip (name, dest = 'hand') {
    const it = bot.inventory.items().find(i => i.name.includes(name))
    if (!it) return { err: 'no item matching ' + name, have: inv() }
    await bot.equip(it, dest)
    return it.name
  }

  // --- place: place held block against reference block face ---
  // face: 'top'|'north'|'south'|'east'|'west'|'bottom' or Vec3 normal
  async function place (x, y, z, face = 'top') {
    const ref = at(x, y, z)
    if (!ref || ref.name === 'air') return { err: 'no reference block at ' + [x, y, z] }
    const normals = { top: [0, 1, 0], bottom: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    const n = Array.isArray(face) ? face : normals[face]
    await bot.placeBlock(ref, new Vec3(...n))
    const placed = at(x + n[0], y + n[1], z + n[2])
    return { placed: placed && placed.name, at: [x + n[0], y + n[1], z + n[2]] }
  }

  // --- dig: break block at x,y,z ---
  async function dig (x, y, z) {
    const b = at(x, y, z)
    if (!b || b.name === 'air') return { err: 'nothing at ' + [x, y, z] }
    await bot.dig(b)
    return { dug: b.name }
  }

  // --- pillar: nerd-pole straight up to y=targetY by jumping and placing
  //     blocks under the bot's feet. material must be in inventory.
  //     Returns {top:[x,y,z], placed:n} or {err}. ---
  async function pillar (targetY, material = 'cobblestone') {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const eq = await equip(material)
    if (eq.err) return eq
    let placed = 0
    for (let i = 0; i < 40; i++) {
      const p = pos()
      if (p.y >= targetY) return { top: p.toArray(), placed }
      const below = at(p.x, p.y - 1, p.z)
      if (!below || below.name === 'air' || below.name === 'cave_air') {
        return { err: 'not standing on solid ground', at: p.toArray(), placed }
      }
      bot.setControlState('jump', true)
      await sleep(280)
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0))
        placed++
      } catch (e) { /* collision at apex — retry next tick */ }
      bot.setControlState('jump', false)
      await sleep(400)
    }
    return { err: 'iteration cap', at: pos().toArray(), placed }
  }

  // --- use: right-click block (doors, buttons, chests open GUI) ---
  async function use (x, y, z) {
    const b = at(x, y, z)
    if (!b) return { err: 'unloaded' }
    await bot.activateBlock(b)
    return { used: b.name }
  }

  // --- chest: open container and read contents ---
  async function chest (x, y, z) {
    const b = at(x, y, z)
    if (!b) return { err: 'unloaded' }
    const c = await bot.openContainer(b)
    const items = {}
    for (const it of c.containerItems()) items[it.name] = (items[it.name] || 0) + it.count
    c.close()
    return { container: b.name, items }
  }

  // --- locate: /locate structure|biome via chat, parse coords from response ---
  function locate (kind, name) {
    return new Promise((resolve) => {
      const onMsg = (msg) => {
        const s = msg.toString()
        const m = s.match(/\[(-?\d+)[,~]?\s*,?\s*(-?\d+)?[,~]?\s*,?\s*(-?\d+)\]/) || s.match(/(-?\d+)\s+(-?\d+)\s+(-?\d+)/)
        if (m) { bot.removeListener('message', onMsg); resolve(s) }
      }
      bot.on('message', onMsg)
      setTimeout(() => { bot.removeListener('message', onMsg); resolve({ err: 'no response' }) }, 5000)
      bot.chat(`/locate ${kind} ${name.includes(':') ? name : 'minecraft:' + name}`)
    })
  }

  // --- setblock: direct world edit (creative/op) ---
  function setblock (x, y, z, name) {
    bot.chat(`/setblock ${x} ${y} ${z} ${name.includes(':') ? name : 'minecraft:' + name}`)
    return 'set ' + [x, y, z]
  }

  // --- fill: /fill x1 y1 z1 x2 y2 z2 block [mode] ---
  function fill (x1, y1, z1, x2, y2, z2, name, mode = '') {
    bot.chat(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${name.includes(':') ? name : 'minecraft:' + name} ${mode}`.trim())
    return 'filled'
  }

  // --- fmt: compact one-line serializers to save tokens ---
  const fmt = {
    ent: e => `${e.name}@${e.dir},${e.d}${e.dy === 'level' ? '' : ',' + e.dy}`,
    grp: g => `${Object.keys(g.blocks).join('+')}x${g.cells}@${g.nearest.dir},${g.nearest.d} box=${g.box}`,
    pos: p => `${p.x},${p.y},${p.z}`
  }

  function help () {
    return 'QUERY: w.status() w.scan(r) w.find(name,r) w.entities(r,f) w.walk(r) w.grid(r,step) w.column(dx,dz) w.inspect(x,y,z) w.inv() w.look(d) w.facing() | ACT: w.go(x,y,z,r) w.stop() w.give(item,n) w.equip(name) w.place(x,y,z,face) w.pillar(y,material) w.dig(x,y,z) w.use(x,y,z) w.chest(x,y,z) w.locate(kind,name) w.setblock(x,y,z,name) w.fill(x1..z2,name,mode) | glyphs: .flat ^up1 ,down1-2 vdrop #wall ~water !lava xhazard ?unloaded @you'
  }

  // --- facing: compass direction bot faces ---
  function facing () {
    const yaw = ((bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    return ['south', 'southwest', 'west', 'northwest', 'north', 'northeast', 'east', 'southeast'][Math.round(yaw / (Math.PI / 4)) & 7]
  }
  // --- events: push-side notifications (the hybrid model's push half).
  //     attach once per bot; events print to REPL log as they happen. ---
  function events () {
    const seen = new Set()
    bot.on('entityHurt', (e) => {
      if (e === bot.entity) console.log('EVENT hurt hp=' + bot.health)
    })
    bot.on('entitySpawn', (e) => {
      if (!e.name || seen.has(e.id)) return
      seen.add(e.id)
      const d = e.position.distanceTo(bot.entity.position)
      if (d <= 24) console.log(`EVENT spawn ${e.name}@${compass(e.position.x - pos().x, e.position.z - pos().z)}${Math.round(d)}`)
    })
    bot.on('entityGone', (e) => seen.delete(e.id))
    bot.on('death', () => console.log('EVENT died'))

    bot.on('rain', () => console.log('EVENT rain=' + bot.isRaining))
  }

  return { status, scan, find, entities, walk, grid, column, inspect, inv, look, facing, compass, rel, help, Vec3, go, stop, give, equip, place, pillar, dig, use, chest, locate, setblock, fill, fmt, snapshot, events }

}
