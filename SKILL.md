# Agent Skill — Understanding a Minecraft World via Active JS Queries

Mental model + toolkit reference for an LLM playing Minecraft through a
mineflayer REPL bot. Load once per session:

```js
w = require('/tmp/mc-exp/world.js')(bot)      // queries + simple actions
s = require('/tmp/mc-exp/skills.js')(bot, w)  // cortico-style skills layer
s2 = require('/tmp/mc-exp/schem.js')(bot)     // Sponge .schem loader/placer
// after reconnect: delete require.cache[require.resolve(path)] then re-require
```

## Mental model

### 1. Query before acting; the world answers in small, structured pieces

Never dump raw objects. Every helper returns LLM-sized data: counts, sorted
lists, ASCII grids, verdicts. If you need something the helpers don't cover,
write a one-off query — but prefer composing `w.*`/`s.*` first.

### 2. Honesty over completeness

- `?` / `_unloaded` / `{name:'?'}` = chunk not loaded. It is NOT air, NOT
  absence. After teleporting, wait ~5-15s (chunk gen spikes the server) and
  re-query before concluding anything.
- `find` = **visible only** (line-of-sight). Empty result means "not seen",
  not "doesn't exist". Buried/occluded targets need `s.probe(..., {where})`
  which reads chunks directly.
- `scanned`/`truncated` fields tell you coverage; treat partial coverage as
  partial truth.

### 3. Spatial reasoning is egocentric first, absolute second

- `w.walk(r)` is the cheapest spatial primitive (~300 chars): `.` flat `^` up-1
  `,` down-1-2 `v` drop≥3 `#` wall `~` water `!` lava `x` hazard-adjacent
  `?` unloaded `@` you, north up. Read it before moving anywhere.
- Directions come back as compass + distance + dy band (`above/below/level`):
  `dir:'southeast', d:8, dy:'below'`. Absolute `[x,y,z]` is for acting.
- Anchors accept `"~"`/`"~-3"` relative to your feet — use them for local work.

### 4. find vs probe — the division of labor (from cortico)

| Need | Tool |
|---|---|
| "what's around me that I can see" | `s.find(target, r)` |
| "is X inside this region, even buried" | `s.probe(shape, anchors, {where:[X]})` |
| "what is this region made of" | `s.probe(shape, anchors)` (≤27 cells → list; else composition) |
| "what block types dominate nearby" | `w.scan(r)` histogram |
| "what's at this exact cell" | `w.inspect(x,y,z)` |

### 4b. s.poi — one-call structure survey

`s.poi([[x1,y1,z1],[x2,y2,z2]])` scans a box for points of interest and
returns them grouped by role: `container` (chests/barrels/furnaces),
`workstation`, `door`, `bed`, `hazard` (tnt/plates/tripwire/lava/spawner),
`marker` (bell/hay/torch), plus `buildings_est` (door+bed clusters ≤5).
This is the converged survey idiom — one call replaces ~5 probes.

### 5. Verify with assertions, not vibes — `s.check`

After every build/mine action, assert the world state:

```js
s.check([
  {at:['~','~-1','~'], is:'oak_planks'},                    // single cell
  {box:[[x1,y1,z1],[x2,y2,z2]], count:{oak_planks:'>=80'}}, // counts
  {box:[[...],[...]], all:'water'},                          // uniform
  {box:[[...],[...]], air:true},                             // hollow
  {box:[[...],[...]], sealed:true, from:[x,y,z]},            // flood-fill leak test
  {inv:{oak_log:'>=5'}}                                      // inventory
])
// verdicts: ok | bad | unknown(unloaded) | error
```

`sealed` flood-fills air inside `box` from `from`; a leak = reaching a passable
cell OUTSIDE the box. The box must bound the enclosed volume INCLUDING its
shell — do not include exterior air (e.g. open roof eaves/overhang are outside
the shell; test the room box, not the whole building silhouette). `from` must
be an interior air cell.

### 5b. Batch placement — `s.placeBatch`

```js
await s.placeBatch([[x,y,z],...], 'oak_planks')
// equips once, places each air cell against an adjacent solid neighbor.
// returns [{at, placed|skip|err}]. Stand within ~4 blocks of targets.
```
Much cheaper than per-block `w.place` loops: one equip, no per-call
blockUpdate wait. Verify a whole batch with one `s.check` count.

### 6. Action vocabulary

- Creative/op shortcuts (preferred for construction): `s.build(shape, anchors,
  block, {fill})`, `s.excavate(shape, anchors)`, `w.setblock`, `w.fill`,
  `w.give(item,n)`. Shapes: `line/rect/triangle/arc/box`; box fill:
  `solid|outline|edges`.
- Survival-style: `w.go(x,y,z,r)` (pathfinder), `w.equip(name)`,
  `w.place(x,y,z,face)`, `w.dig(x,y,z)`, `w.use(x,y,z)`, `w.chest(x,y,z)`.
- `w.locate('structure','village_desert')` → /locate via chat.

### 7. Token discipline


- `w.walk` > `w.grid` > `w.scan` > `s.probe` in cost order for "what's around".
- `w.fmt.ent/grp/pos` for one-line serializations when composing output.
- Slice results yourself: `.slice(0,5)`, pick fields — the REPL prints whatever
  you return, so return only what you need.
- One REPL line can do a whole pipeline: query → decide → act → verify.

### 8. Known pitfalls (learned the hard way)

- `block.biome.name` is empty on 1.21.1 → `w.status().biome` already handles
  via `bot.registry.biomes`.
- `bot.blockAt` returns `null` (unloaded) vs a block named `air` — different
  meanings, both handled by helpers.
- `require` caches modules — after editing world.js/skills.js you MUST
  `delete require.cache[require.resolve(path)]` before re-requiring.
- `await` only works at statement level in the REPL, not inside object
  literals — use `new Promise(r=>setTimeout(r,N)).then(()=>...)` for delays.
- Doors are 2 cells (`half=lower`/`half=upper`); beds 2 cells; portals need
  a fire block to ignite.
- prismarine-viewer on 1.21.1 renders entities but not terrain textures —
  verify builds with `s.check`, not screenshots.

## Demonstrated (verified in-world)

- House 116-122,69-73,124-130: sealed shell, door, crafting table, furnace,
  chest, bed, torch — all `s.check` ok.
- Farm 125-133,68-69,124-132: 42 wheat, water row, farmland, fence ring.
- Nether portal 140-143,68-72,124: obsidian frame, portal blocks, bot
  physically traveled to `the_nether`.

### 9. Schematics (s2)

```js
sc = await s2.load('/tmp/foo.schem')   // {W,H,L,cells,palette}
s2.materials(sc)                       // block histogram — feasibility check
await s2.place(sc, x, y, z)            // /setblock per cell, rate-limited
```

Sponge v2 format: gzip NBT, `BlockData` varint array indexed `(y*L+z)*W+x`,
palette maps `minecraft:name[state=v]` → id. Verify placement with
`s.probe(box, {where:[materials]})` — counts should match `materials()`.
`.schem` on GitHub may be git-LFS: fetch via
`media.githubusercontent.com/media/<owner>/<repo>/<branch>/<path>`.

Demonstrated: amethyst geode schem (19×15×21, 2966 cells) placed at
150-168,20-34,140-160 — probe counts matched source exactly.

- **Traps are real**: probe `stone_pressure_plate`/`tnt`/`tripwire` before
  entering structure interiors — teleporting onto a desert pyramid's plate
  detonates the TNT and destroys the loot.
