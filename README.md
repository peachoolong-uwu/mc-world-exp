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

- **Fabric 1.21.1** at `/tmp/mc-fabric`, port 25566. Chosen over Paper (alters
  mechanics) and vanilla jar (2-3× CPU). Mods: lithium, ferritecore, krypton,
  fabric-api — Lithium preserves vanilla behavior.
- `server.properties`: `online-mode=false`, `view-distance=10`,
  `simulation-distance=8`, survival default.
- Launch: `java -Xms1G -Xmx4G -XX:+UseG1GC -jar fabric-server-launch.jar nogui`
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
- `shot.js` — puppeteer-core screenshot of the viewer. Chrome lives at
  `~/.omp/puppeteer/chrome/...` (installed via `npx puppeteer browsers
  install`); system libs via apt, no LD_LIBRARY_PATH wrapper needed.

## Control pattern (omp harness)

- `hub send name=opbot text="<js>"` — eval JS in bot context
- `hub logs name=opbot lines=N` — read `=>` results
- `hub send name=fabricmc text="<cmd>"` — server console (tp, op, gamemode)

## Known issues

- prismarine-viewer 1.33 + canvas 3.2.3 renders 1.21.1 terrain correctly
  (textures verified via shot.js). Older canvas/viewer combos showed magenta.
- prismarine-chat throws `unknown chat format code` on own-chat echo — harmless.
- Server lag spikes on teleport-driven chunk gen; wait ~5-10s before
  querying new areas. `?`/`_unloaded` in query output = chunks not yet loaded.
