// skills.js — action layer ported from cortico/src/worlds/minecraft semantics.
// Usage:  s = require('/tmp/mc-exp/skills.js')(bot, w)
// (w = world.js instance; re-require both after reconnect.)
//
// Ported concepts:
// - anchors: [x,y,z] with "~"/"~-3" relative to feet (geometry.ts)
// - rasterize: line/rect/triangle/arc/box + fill solid|outline|edges
// - until categories: #ores #logs #leaves #chests #liquids #beds
// - check assertions: at/is, box count/all/air/sealed, inv → ok|bad|unknown|error
// - find vs probe division: find = LOS-visible only; probe = region read,
//   where-mode reads chunks ignoring occlusion
// - verdict honesty: unloaded cells are 'unknown', never counted as match/mismatch

module.exports = function skills (bot, w) {
  const Vec3 = w.Vec3
  const pos = () => bot.entity.position.floored()
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const AIR = new Set(['air', 'cave_air', 'void_air'])
  const LIQUID = new Set(['water', 'lava', 'bubble_column'])

  // ---------- anchors ----------
  function resolveCoord (v, origin) {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null
    const s = String(v).trim()
    if (s === '~') return origin
    if (s.startsWith('~')) {
      const off = Number(s.slice(1))
      return Number.isFinite(off) ? origin + Math.floor(off) : null
    }
    const abs = Number(s)
    return Number.isFinite(abs) && s !== '' ? Math.floor(abs) : null
  }
  function anchors (list) {
    const o = pos()
    return list.map(a => ({
      x: resolveCoord(a[0], o.x), y: resolveCoord(a[1], o.y), z: resolveCoord(a[2], o.z)
    }))
  }

  // ---------- rasterize ----------
  const ANCHOR_COUNT = { line: 2, rect: 2, triangle: 3, arc: 3, box: 2 }
  function lineInto (out, a, b) {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z))
    if (n === 0) { out.set(a.x + ',' + a.y + ',' + a.z, a); return }
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const c = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), z: Math.round(a.z + (b.z - a.z) * t) }
      out.set(c.x + ',' + c.y + ',' + c.z, c)
    }
  }
  function rasterize (shape, pts, fill = 'solid') {
    if (pts.length !== ANCHOR_COUNT[shape]) return { error: `${shape} needs ${ANCHOR_COUNT[shape]} anchors, got ${pts.length}` }
    const out = new Map()
    if (shape === 'line') lineInto(out, pts[0], pts[1])
    else if (shape === 'rect') {
      const [a, b] = pts
      const flat = ['x', 'y', 'z'].filter(ax => a[ax] === b[ax])
      if (flat.length === 0) return { error: 'rect anchors must share one axis' }
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++)
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++)
          for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++)
            out.set(x + ',' + y + ',' + z, { x, y, z })
    } else if (shape === 'triangle') {
      const edge = new Map()
      lineInto(edge, pts[1], pts[2])
      for (const p of edge.values()) lineInto(out, pts[0], p)
    } else if (shape === 'arc') {
      // circumcenter of 3 points in their plane
      const [a, b, c] = pts
      const sub = (p, q) => [p.x - q.x, p.y - q.y, p.z - q.z]
      const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
      const ba = sub(b, a), ca = sub(c, a)
      const nrm = cross(ba, ca)
      const nl = Math.sqrt(dot(nrm, nrm))
      if (nl < 1e-6) return { error: 'arc anchors are collinear' }
      const bal = dot(ba, ba), cal = dot(ca, ca)
      const t1 = cross(ca, nrm).map(v => v * bal / (2 * nl * nl))
      const t2 = cross(nrm, ba).map(v => v * cal / (2 * nl * nl))
      const ctr = { x: a.x + t1[0] + t2[0], y: a.y + t1[1] + t2[1], z: a.z + t1[2] + t2[2] }
      const r = Math.sqrt((a.x - ctr.x) ** 2 + (a.y - ctr.y) ** 2 + (a.z - ctr.z) ** 2)
      const u = sub(a, ctr).map(v => v / r)
      const nU = nrm.map(v => v / nl)
      const v2 = cross(nU, u)
      const angOf = p => Math.atan2(dot(sub(p, ctr), v2), dot(sub(p, ctr), u))
      let a1 = angOf(a), a2 = angOf(b), a3 = angOf(c)
      // direction a→b→c: ensure b between a and c
      const norm = x => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      let sweep = norm(a3 - a1)
      if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI
      const steps = Math.max(8, Math.ceil(Math.abs(sweep) * r * 2))
      for (let i = 0; i <= steps; i++) {
        const th = a1 + sweep * (i / steps)
        const cell = {
          x: Math.round(ctr.x + r * (Math.cos(th) * u[0] + Math.sin(th) * v2[0])),
          y: Math.round(ctr.y + r * (Math.cos(th) * u[1] + Math.sin(th) * v2[1])),
          z: Math.round(ctr.z + r * (Math.cos(th) * u[2] + Math.sin(th) * v2[2]))
        }
        out.set(cell.x + ',' + cell.y + ',' + cell.z, cell)
      }
    } else if (shape === 'box') {
      const [a, b] = pts
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }
      const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
      for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) {
        const onFace = (x === lo.x || x === hi.x ? 1 : 0) + (y === lo.y || y === hi.y ? 1 : 0) + (z === lo.z || z === hi.z ? 1 : 0)
        if (fill === 'solid' || (fill === 'outline' ? onFace >= 1 : onFace >= 2)) out.set(x + ',' + y + ',' + z, { x, y, z })
      }
    }
    return [...out.values()]
  }

  // ---------- until categories ----------
  const CATEGORIES = {
    ores: n => n.endsWith('_ore') || n === 'ancient_debris',
    logs: n => n.endsWith('_log') || n.endsWith('_stem'),
    leaves: n => n.endsWith('_leaves'),
    chests: n => n === 'chest' || n === 'trapped_chest' || n === 'barrel',
    liquids: n => n === 'water' || n === 'lava',
    beds: n => n.endsWith('_bed')
  }
  function matchName (name) {
    if (name.startsWith('#')) {
      const pred = CATEGORIES[name.slice(1)]
      return pred ? (b) => b && pred(b.name) : null
    }
    return (b) => b && (b.name === name || b.name.includes(name))
  }

  // ---------- find: LOS-gated visible search (cortico find) ----------
  function find (target, r = 48, count = 20) {
    const pred = matchName(target)
    if (!pred) return { error: 'unknown category ' + target }
    const p = pos()
    // blocks
    const hits = bot.findBlocks({ matching: pred, maxDistance: r, count: 64 })
    const visible = hits.filter(v => { const b = at(v.x, v.y, v.z); return b && canSee(b) })
      .map(v => ({ blockAt: [v.x, v.y, v.z], name: at(v.x, v.y, v.z).name, ...w.rel(v) }))
      .sort((a, b) => a.d - b.d).slice(0, count)
    // entities
    const ents = w.entities(r, target.startsWith('#') ? null : target)
      .filter(e => e.name && (target.startsWith('#') ? false : e.name.includes(target)))
      .map(e => ({ seenAt: [e.pos.x, e.pos.y, e.pos.z], name: e.name, d: e.d, dir: e.dir, dy: e.dy }))
      .slice(0, count)
    return { blocks: visible, entities: ents, scanned: hits.length, note: 'visible-only; occluded targets not reported' }
  }
  function canSee (b) {
    try { return bot.canSeeBlock(b) } catch (e) { return true }
  }

  // ---------- probe: region read (cortico probe) ----------
  // ≤27 cells → per-cell list; larger → aggregate composition.
  // where: list of names/#categories → coords ignoring occlusion.
  function probe (shape, anchorList, opts = {}) {
    const pts = anchors(anchorList)
    if (pts.some(p => p.x === null || p.y === null || p.z === null)) return { error: 'bad anchor' }
    const cells = rasterize(shape, pts, opts.fill || 'solid')
    if (cells.error) return cells
    if (opts.where) {
      const preds = opts.where.map(nm => ({ nm, pred: matchName(nm) }))
      const bad = preds.filter(p2 => !p2.pred).map(p2 => p2.nm)
      const found = {}
      let unloaded = 0
      for (const c of cells) {
        const b = at(c.x, c.y, c.z)
        if (b === null) { unloaded++; continue }
        for (const { nm, pred } of preds) {
          if (pred && pred(b)) (found[nm] = found[nm] || []).push([c.x, c.y, c.z])
        }
      }
      for (const k of Object.keys(found)) {
        const p = pos()
        found[k].sort((a, b2) => (a[0] - p.x) ** 2 + (a[1] - p.y) ** 2 + (a[2] - p.z) ** 2 - ((b2[0] - p.x) ** 2 + (b2[1] - p.y) ** 2 + (b2[2] - p.z) ** 2))
        if (found[k].length > 6) found[k] = { total: found[k].length, nearest: found[k].slice(0, 6) }
      }
      return { cells: cells.length, found, unloaded, unknownNames: bad }
    }
    if (cells.length <= 27) {
      const list = cells.map(c => { const b = at(c.x, c.y, c.z); return { at: [c.x, c.y, c.z], name: b ? b.name : '?' } })
      return { cells: cells.length, list }
    }
    const counts = {}; let unloaded = 0
    for (const c of cells) {
      const b = at(c.x, c.y, c.z)
      if (b === null) { unloaded++; continue }
      if (!AIR.has(b.name)) counts[b.name] = (counts[b.name] || 0) + 1
    }
    return { cells: cells.length, composition: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)), unloaded }
  }

  // ---------- poi: one-call structure survey (converged idiom from A/B) ----
  // Both experiment arms independently did: probe box for chest/door/bed/
  // workstation, then walk to each chest. poi() is that idiom as one call.
  // Returns positions grouped by role; doors/beds clustered into buildings.
  const POI = {
    container: ['chest', 'barrel', 'trapped_chest', 'chest_minecart', 'furnace', 'blast_furnace', 'smoker', 'hopper', 'dispenser', 'dropper', 'shulker_box'],
    workstation: ['composter', 'stonecutter', 'smithing_table', 'cartography_table', 'fletching_table', 'lectern', 'brewing_stand', 'loom', 'grindstone', 'cauldron', 'crafting_table'],
    door: ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door', 'iron_door'],
    bed: ['white_bed', 'red_bed', 'blue_bed', 'green_bed', 'yellow_bed', 'orange_bed', 'purple_bed', 'pink_bed', 'brown_bed', 'black_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'lime_bed', 'magenta_bed', 'light_blue_bed'],
    hazard: ['tnt', 'stone_pressure_plate', 'tripwire', 'tripwire_hook', 'lava', 'spawner', 'monster_spawner', 'cobweb'],
    marker: ['bell', 'hay_block', 'lantern', 'campfire', 'soul_campfire', 'beehive', 'bee_nest']
  }
  function poi (anchorList) {
    const pts2 = anchors(anchorList)
    if (pts2.some(p => p.x === null || p.y === null || p.z === null)) return { error: 'bad anchor' }
    const cells = rasterize('box', pts2, 'solid')
    if (cells.error) return cells
    const nameToRole = {}
    for (const [role, list] of Object.entries(POI)) for (const nm of list) nameToRole[nm] = role
    const out = { cells: cells.length, unloaded: 0 }
    const doorBed = []
    for (const c of cells) {
      const b = at(c.x, c.y, c.z)
      if (b === null) { out.unloaded++; continue }
      const role = nameToRole[b.name]
      if (!role) continue
      ;(out[role] = out[role] || []).push({ pos: [c.x, c.y, c.z], name: b.name })
      if (role === 'door' || role === 'bed') doorBed.push([c.x, c.y, c.z])
    }
    // dedupe multi-cell blocks (doors/beds occupy 2 cells vertically) then cluster ≤8 → buildings
    const seen = new Set()
    const uniq = doorBed.filter(p => { const k = p[0] + ',' + p[1] + ',' + p[2]; if (seen.has(k)) return false; seen.add(k); return true })
      .filter(p => !doorBed.some(q => q !== p && q[0] === p[0] && q[2] === p[2] && q[1] === p[1] - 1)) // drop upper half
    const clusters = []
    for (const p of uniq) {
      const c = clusters.find(cl => cl.some(q => Math.max(Math.abs(q[0]-p[0]), Math.abs(q[1]-p[1]), Math.abs(q[2]-p[2])) <= 5))
      if (c) c.push(p); else clusters.push([p])
    }
    out.buildings_est = clusters.length
    // cap each role list at 12 entries to stay compact
    for (const role of Object.keys(POI)) {
      if (out[role] && out[role].length > 12) out[role] = { total: out[role].length, nearest: out[role].slice(0, 12) }
    }
    return out
  }

  // ---------- check: assertion engine (cortico mc_check) ----------
  // checks: array of {at:[x,y,z],is:name} | {box:[[x,y,z],[x,y,z]],count:{name:n|">=n"}} |
  //         {box,all:name} | {box,air:true} | {box,sealed:true,from:[x,y,z]} | {inv:{item:n}}
  function check (checks) {
    return checks.map(c => {
      try { return evalCheck(c) } catch (e) { return { verdict: 'error', detail: e.message } }
    })
  }
  function boxCells (box) {
    const [a, b] = anchors(box)
    const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }
    const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
    const cells = []
    for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) cells.push({ x, y, z })
    return cells
  }
  function cmp (want, actual) {
    const s = String(want)
    if (s.startsWith('>=')) return actual >= Number(s.slice(2))
    if (s.startsWith('<=')) return actual <= Number(s.slice(2))
    return actual === Number(s)
  }
  function evalCheck (c) {
    if (c.at) {
      const [p] = anchors([c.at])
      const b = at(p.x, p.y, p.z)
      if (b === null) return { verdict: 'unknown', detail: `(${p.x},${p.y},${p.z}) unloaded` }
      const ok = c.is ? matchName(c.is)(b) : !AIR.has(b.name)
      return { verdict: ok ? 'ok' : 'bad', detail: `(${p.x},${p.y},${p.z}) is ${b.name}, want ${c.is || 'non-air'}` }
    }
    if (c.inv) {
      const have = w.inv()
      const bad = []
      for (const [item, want] of Object.entries(c.inv)) {
        const n = Object.entries(have).filter(([k]) => k.includes(item)).reduce((s, [, v]) => s + v, 0)
        if (!cmp(want, n)) bad.push(`${item}: have ${n}, want ${want}`)
      }
      return bad.length ? { verdict: 'bad', detail: bad.join('; ') } : { verdict: 'ok', detail: 'inv satisfied' }
    }
    if (c.box) {
      const cells = boxCells(c.box)
      let unloaded = 0
      if (c.air) {
        const nonAir = []
        for (const cell of cells) { const b = at(cell.x, cell.y, cell.z); if (b === null) { unloaded++; continue } if (!AIR.has(b.name)) nonAir.push(b.name) }
        return { verdict: nonAir.length ? 'bad' : unloaded ? 'unknown' : 'ok', detail: nonAir.length ? `${nonAir.length} non-air (${[...new Set(nonAir)].slice(0, 5).join(',')})` : 'all air' + (unloaded ? `, ${unloaded} unloaded` : '') }
      }
      if (c.all) {
        const pred = matchName(c.all)
        const badCells = []
        for (const cell of cells) { const b = at(cell.x, cell.y, cell.z); if (b === null) { unloaded++; continue } if (!pred(b)) badCells.push(b.name) }
        return { verdict: badCells.length ? 'bad' : unloaded ? 'unknown' : 'ok', detail: badCells.length ? `${badCells.length} mismatch (${[...new Set(badCells)].slice(0, 5).join(',')})` : `all ${c.all}` + (unloaded ? `, ${unloaded} unloaded` : '') }
      }
      if (c.count) {
        const counts = {}
        for (const cell of cells) { const b = at(cell.x, cell.y, cell.z); if (b === null) { unloaded++; continue } counts[b.name] = (counts[b.name] || 0) + 1 }
        const bad = []
        for (const [nm, want] of Object.entries(c.count)) {
          const n = Object.entries(counts).filter(([k]) => k.includes(nm)).reduce((s, [, v]) => s + v, 0)
          if (!cmp(want, n)) bad.push(`${nm}: ${n}/${want}`)
        }
        return { verdict: bad.length ? 'bad' : unloaded ? 'unknown' : 'ok', detail: bad.join('; ') || 'counts ok' + (unloaded ? `, ${unloaded} unloaded` : '') }
      }
      if (c.sealed) {
        // flood fill from 'from' (or first air cell) through air+liquid; leak = reach outside box
        const lo = { x: Math.min(...cells.map(c2 => c2.x)), y: Math.min(...cells.map(c2 => c2.y)), z: Math.min(...cells.map(c2 => c2.z)) }
        const hi = { x: Math.max(...cells.map(c2 => c2.x)), y: Math.max(...cells.map(c2 => c2.y)), z: Math.max(...cells.map(c2 => c2.z)) }
        const inBox = (x, y, z) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y && z >= lo.z && z <= hi.z
        let start = c.from ? anchors([c.from])[0] : null
        if (!start) { for (const cell of cells) { const b = at(cell.x, cell.y, cell.z); if (b && AIR.has(b.name)) { start = cell; break } } }
        if (!start) return { verdict: 'unknown', detail: 'no air start' }
        const seen = new Set(); const q = [start]; const leaks = []
        while (q.length && leaks.length < 3) {
          const cur = q.pop()
          const k = cur.x + ',' + cur.y + ',' + cur.z
          if (seen.has(k)) continue
          seen.add(k)
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
            const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz
            const nb = at(nx, ny, nz)
            if (!inBox(nx, ny, nz)) {
              // leak only if the outside cell is itself passable (hole through shell)
              if (nb === null) { unloaded++; continue }
              if (AIR.has(nb.name) || LIQUID.has(nb.name)) { leaks.push([nx, ny, nz]); break }
              continue
            }
            if (nb === null) { unloaded++; continue }
            if (AIR.has(nb.name) || LIQUID.has(nb.name)) q.push({ x: nx, y: ny, z: nz })
          }
        }
        return { verdict: leaks.length ? 'bad' : 'ok', detail: leaks.length ? `leaks at ${JSON.stringify(leaks.slice(0, 3))}` : 'sealed' + (unloaded ? `, ${unloaded} unloaded` : '') }
      }
    }
    return { verdict: 'error', detail: 'unrecognized assert' }
  }

  // ---------- build: shaped placement via /fill + /setblock (creative) ----------
  // For box shapes use /fill; other shapes setblock per cell.
  function build (shape, anchorList, block, opts = {}) {
    const pts = anchors(anchorList)
    if (pts.some(p => p.x === null)) return { error: 'bad anchor' }
    const name = block.includes(':') ? block : 'minecraft:' + block
    if (shape === 'box' && (opts.fill || 'solid') === 'solid') {
      const [a, b] = pts
      bot.chat(`/fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${name} ${opts.mode || ''}`.trim())
      return { sent: 'fill', box: [a, b] }
    }
    const cells = rasterize(shape, pts, opts.fill || 'solid')
    if (cells.error) return cells
    if (cells.length > 4096) return { error: cells.length + ' cells > 4096 cap' }
    // batch into /fill lines of contiguous runs? simple: chunk setblock commands
    for (const c of cells) bot.chat(`/setblock ${c.x} ${c.y} ${c.z} ${name}`)
    return { sent: 'setblock', cells: cells.length }
  }

  // ---------- excavate: shaped dig via /fill air (creative) ----------
  function excavate (shape, anchorList, opts = {}) {
    return build(shape, anchorList, 'air', { ...opts, mode: 'replace' })
  }

  return { anchors, rasterize, find, probe, poi, check, build, excavate, matchName, CATEGORIES }
}
