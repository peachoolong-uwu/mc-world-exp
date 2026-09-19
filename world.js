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

  function help () {
    return 'w.status() w.scan(r) w.find(name,r) w.entities(r,f) w.walk(r) w.grid(r,step) w.column(dx,dz) w.inspect(x,y,z) w.inv() w.look(d) w.facing() | grid glyphs: .flat ^up1 ,down1-2 vdrop #wall ~water !lava xhazard ?unloaded @you'
  }

  // --- facing: compass direction bot faces ---
  function facing () {
    const yaw = ((bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    return ['south', 'southwest', 'west', 'northwest', 'north', 'northeast', 'east', 'southeast'][Math.round(yaw / (Math.PI / 4)) & 7]
  }
  return { status, scan, find, entities, walk, grid, column, inspect, inv, look, facing, compass, rel, help, Vec3 }
}
