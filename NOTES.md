# NOTES — world-perception design for LLM-in-Minecraft

## The experiment

Two established approaches:
1. **Push**: env periodically sends the LLM a snapshot (nearby blocks, entities).
2. **Pull**: LLM calls tools to query the world on demand.

We explore a third: **the LLM writes JS directly**, eval'd in a mineflayer REPL
bot, then common patterns get condensed into `w.*` helpers to save tokens and
reasoning. Progression: manual queries → observe repetition → codify → compress
output.

## Reference projects studied

### Numen (github.com/Dwinovo/minecraft-numen) — pull, server-side mod

Fabric/NeoForge mod; LLM companion is a real `ServerPlayer`, agent loop on
owner's client. ~10 pull tools run server-side:

- `scan_blocks(radius≤192, block_ids)` → **connected-component groups**
  (union-find, 3×3×3 adjacency), not raw cells. ~16 groups vs hundreds of
  coords. Each group: cells, per-type counts, nearest{x,y,z,direction,distance},
  box, positions only if ≤16 cells. Group ids (g1,g2…) consumable by `mine`.
- `look_around(radius)` → **egocentric ASCII affordance grid**, `@` center,
  north up, 1 cell = 1 block: `.` flat `^` up-1 `,` down-1-2 `v` drop≥3 `#` wall
  `~` water `!` lava `x` hazard-adjacent (costmap inflation) `?` unloaded.
  Cells classified with the *same* predicates the pathfinder uses.
- `inspect_block(x,y,z)` → blockstate props, hardness, correct-tool check,
  estimated mining ticks, in_reach.
- `scan_nearby_entities` → distance-sorted, capped 20, category labels.
- `locate_biome`/`locate_structure` → vanilla /locate semantics, time-sliced.
- `lookup_recipe` → shaped recipes rendered as ASCII grids.
- Push side: only `<runtime_state>` (inventory/effects/task) computed fresh per
  request, **never enters history** — "进了历史就是理直气壮的旧数" (stale data
  in history is confidently-wrong data). `<known_blocks>` station memory.
- Honesty: `truncated` flags, `groups_total` only when complete, unloaded =
  `?`/`UNKNOWN` never silent air.

### Cortico (github.com/Pal-AI-Lab/Cortico) — hybrid push/pull, mineflayer

- Push: `minecraft.world.snapshot` event, ≥10s apart, **segment-level diffing**
  (10 keyed prose segments, only dirty ones sent), fingerprint suppression,
  full anchor on reconnect/context-truncation.
- Pull: `mc_bag`/`mc_queue`/`mc_blocked` instant reads (per-round fingerprint
  dedup — same question twice → "already answered"), `mc_check` assertion
  engine (`{"at":[x,y,z],"is":"chest"}`, `{"box":…,"sealed":true}` →
  ok/bad/unknown/error), `find`/`probe` skills (anchor+shape region reads).
- Perception discipline: **LOS gating** — occluded things are "heard"
  (direction only, no distance) or absent. `probe where` is the sanctioned
  occlusion bypass.
- Compression: 16-block radius, per-block-name nearest-only dedup, entities
  capped at 12 with `entitiesOmitted` count, distance bucketed to 2-block
  granularity for diff keys.
- Coordinate semantics named explicitly: `blockAt` (occupied cell) vs
  `seenAt` (entity sighting) vs standable-adjacent-cell.
- Stale evidence labeled with age, never silently dropped or shown as current.

## What we adopted in world.js

| Pattern | From | Our impl |
|---|---|---|
| Connected-component grouping | numen | `w.find` → union-find, groups w/ nearest+dir+box |
| Egocentric affordance grid | numen | `w.walk` — same glyph set + hazard inflation |
| `?` = unloaded, not air | both | `scan._unloaded`, `walk`/`inspect` `?` cells |
| Compass + distance + dy band | both | `rel()` → `{d, dir, dy}` on finds/entities |
| Per-name histogram overview | cortico | `w.scan(r)` block-type counts |
| Block detail probe | numen | `w.inspect` — states/hardness/diggable/inReach/canSee |
| Self status | both | `w.status` — pos/dim/time/health/biome/light/facing |

## Gotchas discovered (mineflayer + Fabric 1.21.1)

- `block.biome.name` is **empty** on 1.21.1 — use
  `bot.registry.biomes[block.biome.id].name` fallback.
- `bot.blockInSight` deprecated → `bot.blockAtCursor`.
- `bot.blockAt` returns `null` for unloaded chunks — distinguishable from air,
  use it for honesty (`?`).
- `new Function` statement fallback loses completion values — wrap in `eval`
  to get last-statement value like a real REPL.
- prismarine-viewer needs `canvas` (native) — npm may skip it as optional;
  install explicitly.
- Chromium on a no-sudo box: download debs for libatk/libatk-bridge/libatspi/
  libxcomposite, `dpkg-deb -x`, `LD_LIBRARY_PATH` wrapper script.
- Teleport-driven chunk gen spikes the 2-core server ~15s; queries during that
  window correctly report `?` — wait and retry.

## Token-cost observations

- `w.walk(8)` ≈ 300 chars for a 17×17 semantic map — cheapest spatial primitive.
- `w.find` grouping: 189 log cells → ~25 groups; positions only when ≤16 cells.
- `util.inspect` output is verbose (Vec3 objects, undefined fields) — a compact
  serializer (e.g. `pillager@se,35,below`) is the next optimization.
- Entity `health`/`heldItem` often undefined — omit empty fields in output.

## Field notes — village exploration (2026-09-19)

## Roadmap

- `/locate structure village_desert` returns structure origin, NOT guaranteed
  building position — village buildings spread ±60 blocks from it. Probe wide.
- Desert village probe (60r, ±15y): bell at center, 3 composters, 4 beds,
  0 chests. Entities: camel, cat, villagers, iron_golem + night hostiles.
- `w.entities` + `w.fmt.ent` gives one-line-per-entity output —
  `villager@south,38,below` — much cheaper than object dumps.
- `s.find` (LOS) returned 0 chests in village; `s.probe where` is the right
  tool for loot/POI discovery in generated structures.

- [x] Compact output serializer (`w.fmt.ent/grp/pos`)
- [x] `w.locate` via `/locate` command; container contents via `w.chest`
- [x] `s.check` assertion engine (cortico mc_check port: at/count/all/air/sealed/inv)
- [x] LOS gating on `s.find` (visible-only by design; `s.probe where` bypasses)
- [ ] A/B: same task via pushed snapshot vs active JS queries — measure tokens
      and decision quality
- [ ] Consider 1.20.4 server for correct viewer textures
