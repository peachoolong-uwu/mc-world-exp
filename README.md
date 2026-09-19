# mc-world-exp

Experiment: how can an LLM understand a Minecraft world efficiently and accurately
enough to play — via **actively-written JS queries** (pull) vs **pushed snapshots**.

## Architecture

```
LLM ──stdin──▶ repl-bot.js ──▶ mineflayer bot "OpBot" ──▶ Fabric 1.21.1 server :25566
                  │                    │
                  │                    └─ prismarine-viewer :3007 ──▶ cloudflared tunnel
                  └─ world.js (w.* query helpers, loaded via require)
```

## Server setup (no sudo, 2 CPU / 13 GB)

- **Fabric 1.21.1** at `/tmp/mc-fabric`, port 25566. Chosen over Paper (alters
  mechanics) and vanilla jar (2-3× CPU). Mods: lithium, ferritecore, krypton,
  fabric-api — Lithium preserves vanilla behavior.
- `server.properties`: `online-mode=false`, `view-distance=8`,
  `simulation-distance=6`, survival default.
- Launch: `java -Xms512M -Xmx2G -XX:+UseG1GC -jar fabric-server-launch.jar nogui`
- Node 20.18.1 local install at `/tmp/node20` (tarball, no root).
- Bot is opped (`op OpBot` via server console) + creative mode; persists across
  reconnects.

## Files

- `repl-bot.js` — supervised REPL bot. Each stdin line is eval'd as async JS with
  `bot`, `mineflayer`, `require` in scope. Expression tried first; statement
  fallback uses `eval` so the completion value is returned. Auto-reconnects,
  queues lines while offline. prismarine-viewer attaches on spawn (:3007),
  `bot.viewer.close()` on disconnect to free the port.
- `world.js` — `w = require('./world.js')(bot)` → compact query helpers
  (`w.status/scan/find/entities/walk/grid/column/inspect/inv/look/facing`).
  Re-require after reconnect. See NOTES.md for design rationale.
- `shot.js` — puppeteer-core screenshot of the viewer (needs extracted system
  libs, see NOTES.md).

## Control pattern (omp harness)

- `hub send name=opbot text="<js>"` — eval JS in bot context
- `hub logs name=opbot lines=N` — read `=>` results
- `hub send name=fabricmc text="<cmd>"` — server console (tp, op, gamemode)

## Known issues

- prismarine-viewer on 1.21.1: entities/player render, terrain textures are
  magenta (atlas tops out ~1.20.x). Drop to 1.20.4 for pretty terrain.
- prismarine-chat throws `unknown chat format code` on own-chat echo — harmless.
- Server lag spikes on teleport-driven chunk gen (2 cores); wait ~10s before
  querying new areas. `?`/`_unloaded` in query output = chunks not yet loaded.
