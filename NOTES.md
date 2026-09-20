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

## A/B: push snapshot vs pull queries (2026-09-19)

`w.snapshot(r)` implemented — cortico-style pushed narration, ~400 chars:
```
pos -368,77,-384 overworld desert day facing west
body hp20 food20 creative on:air light:0
entities(1+): cat@west5
blocks: smooth_sandstone@southwest2 bell@east3 torch@southeast6 ...
inv: empty
```

Token economics:
- Push: ~400 chars/turn regardless of relevance. Over a 20-turn task = ~8k
  chars of mostly-stale context. Cortico mitigates with segment diffing +
  fingerprint suppression (only dirty segments sent).
- Pull: zero baseline cost; each query ~100-500 chars only when needed.
  A "walk to village and loot chests" task needs ~3-5 queries (~1.5k chars)
  vs ~8k pushed. Pull wins when the agent knows what to ask.
- Push wins when: agent doesn't know what it doesn't know (ambush by
  creeper, environment changed while planning). Hybrid is the answer:
  push only *events* (damage taken, entity approach, task completion),
  pull everything else. This matches numen's `<runtime_state>` design —
  volatile state pushed fresh per-request, world data pulled on demand.

## Field notes — schematic placement (2026-09-19)

- `/setblock` **silently fails on chunks no player has loaded**. Placing a
  schematic 500 blocks away produced zero blocks with zero errors. Fix:
  `/forceload add x1 z1 x2 z2` before placing, `forceload remove` after
  (schem.js place() does this automatically now).
- JSON schematics may lack blockstate properties — `oak_door` without
  `half`/`facing` fails to place. Multi-cell blocks (doors, beds) need
  explicit states; verify with `s.check` after placement.
- Sponge .schem on GitHub is often git-LFS — use
  `media.githubusercontent.com/media/...` not `raw.githubusercontent.com`.

## Field notes — desert pyramid (2026-09-19)

- `/locate desert_pyramid` → probe found the classic layout: 4 chests at
  y=54, 9 TNT below, stone_pressure_plate trap, suspicious_sand.
- **Teleported into the treasure room, landed ON the pressure plate, TNT
  detonated** — chests destroyed, contents dropped as items (visible as a
  burst of `EVENT spawn item@` events). Lesson: probe for
  `stone_pressure_plate`/`tnt` BEFORE entering any structure's lower level;
  approach from the side, dig around the plate, never drop straight in.
- `bot.openContainer` fails with "neither a block nor an entity" if the
  target block is air — always `w.inspect`/`s.probe` the cell first.

## A/B measured — same scene, push vs pull (2026-09-19)

Scene: desert pyramid surface, 3 hostiles below, loot items on ground.

Push (`w.snapshot(16)`, ~380 chars):
```
body hp20 food20 creative on:air light:0
entities(3+): creeper@southeast9below creeper@northwest12below husk@east13below
blocks: sandstone_stairs@south2 cut_sandstone@south2 orange_terracotta@south3 ...
inv: rotten_fleshx1 gunpowderx1 cut_sandstonex16
```

Pull equivalent (3 queries, ~600 chars): `w.status()` + `w.entities(16)` +
`w.scan(8)` — more precise (exact coords, full histogram) but 1.6× the tokens
and requires knowing what to ask.

Verdict: push snapshot is the better *opening move* per scene (~380 chars for
situational awareness); pull queries win for targeted questions ("where are
the chests" → `s.probe where` ~200 chars vs snapshot can't answer it at all).
Optimal loop: snapshot on arrival → targeted pulls → events for surprises.

## A/B task-level — pull-only vs hybrid, village survey (2026-09-20)

Setup: subagent plays OpBot via a single `mc(code)` tool (eval in bot REPL).
Task: walk to plains village ~[1136,~,560], survey, report buildings/chests/
entities/hazards as JSON. Ground truth collected by operator probe beforehand
(exp/ground-truth-village.json). Survival mode, no slash commands.

- Arm A (pull-only): 40 mc calls, 16.3k chars of mc I/O, 79k in / 10k out LLM
  tokens. Report: 3/3 chests exact pos+contents, 8 buildings, full census,
  found flooded cave + mineshaft hazards. No events, no snapshot.
- Arm B (hybrid: initial snapshot + EVENT push): 99 calls but ~43 wasted on
  infra failures (kick loop, kernel reset) — effective ~56 calls, 35k chars
  mc I/O, 68k in / 20k out tokens. Report: 3/3 chests, 10 buildings, census,
  same hazards. Zero EVENT lines actually fired during the run (daytime,
  no damage taken) — the push channel was silent.

Findings:
1. For a static survey task, push adds nothing — both arms converged on
   probe-driven pull (`s.probe where` for chests, door positions for building
   count). The snapshot's value is the *opening move* only; arm B still had
   to pull everything that mattered.
2. Both arms independently discovered the same efficient pattern: probe the
   whole village box for `chest`/`door`/`bed` in ONE call, then walk to each
   chest. The "survey" task collapses to ~3 queries once you know the idiom.
3. Token cost is dominated by LLM reasoning tokens (68-79k in), not world
   data (16-35k chars mc I/O ≈ 4-9k tokens). Perception compression matters
   less than decision efficiency.
4. `w.go` long walks are the fragile point: pathfinder goals survive
   disconnects and cause "Invalid move player packet" kick loops after
   operator teleports. Fix: restart bot process, or `w.stop()` before tp.
5. EVENT push earned its keep zero times in a peaceful daytime survey —
   it exists for the cases pull can't see (damage, ambush, night spawns).
   Keep it cheap and rare; don't push snapshots on a timer.

Verdict: **pull-first, push-events-only** confirmed at task level. The
snapshot is a nice-to-have orientation aid (~380 chars), not a substitute
for knowing what to ask.

## Infra bug — teleport kick loop (2026-09-20)

`/tp` while pathfinder holds a goal → bot sends move packets from the old
position → "Invalid move player packet" kick → reconnect → stale goal
resends → loop. Fix in repl-bot.js spawn handler: `setGoal(null)` +
`clearControlStates()` + `canDig=false`/`allow1by1towers=false` movements.
Also: `s.poi(box)` added — the survey idiom both A/B arms converged on
(probe for container/workstation/door/bed/hazard/marker + building count
from door-bed clustering). One call ≈ 5 probes.

## Repair task — damaged village house (2026-09-20)

Setup: house [1134-1144,70-80,566-572] damaged (wall hole, roof corner,
door frame). Subject: pull-only mc() tool, survival, materials pre-given.
GT snapshot: /tmp/gt-buildingA.json (2925 cells).

Result: 112 mc calls, 27k chars I/O, 387k in / 102k out LLM tokens.
Repair quality: 2910/2925 cells match GT (99.5%). Missing: 2 bed cells,
1 torch, 1 grass. Extra: 9 blocks (scaffolding/logs left in walls).
Changed: 2 (cobblestone→oak_log, oak_log→oak_planks — equivalent).
Visual: roof/door/walls restored, style consistent.

Key findings:
1. Subject converged on the right idiom fast: probe box → per-layer ASCII
   map → batch place via helper fn. ~15 calls to survey, ~40 to repair.
2. s.check sealed verdict was a false positive — box boundary z=566 is
   exterior (roof overhang), flood correctly reached it. Subject spent
   ~25 calls debugging the tool instead of trusting its own flood-fill.
   Lesson: s.check needs a `from` point strictly inside the shell, and
   the box must exclude exterior overhang cells.
3. w.place is the bottleneck: each block needs equip+place+verify, and
   blockUpdate timeouts force retries. A batch-place helper (place many
   cells in one mc call) would cut repair calls ~3×.
4. Death mid-task (night, 13hp) lost inventory + position — operator
   restore needed. For repair tasks, stage at day + clear weather or
   give the subject a bed to skip night.
