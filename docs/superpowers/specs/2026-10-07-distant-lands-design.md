# Distant Lands — Design Spec

Date: 2026-10-07
Status: approved for implementation (autonomous session; the user requested an end-to-end build and a PR, so the PR is the review gate)

## 1. Intent

**What the user asked for (verbatim requirements, condensed):**

- A Minecraft Bedrock **26.3** add-on inspired by *Distant Horizons* (DH): extend the visible world far beyond the vanilla chunk render distance with lightweight level-of-detail (LOD) terrain, progressively replaced by real terrain as the player approaches.
- Configurable maximum LOD distance **up to 32 chunks**.
- Do **not** force-load thousands of vanilla chunks; keep fully loaded chunks to a minimum.
- Aggressive LOD management, efficient meshing, chunk prioritisation, caching, background processing.
- Visual consistency: terrain height, major structures, water, biomes, vegetation silhouettes.
- Configuration: max distance, LOD quality, update frequency, generation priority, performance settings, plus extra behaviour/resource options beyond DH (generation, update, caching, display).
- Nearby terrain always highest priority; distant terrain progressively lower detail.
- Survival compatible; works with procedural terrain; preserves seed and generation rules.
- Clean configuration UI, polished LOD transitions, clear performance settings.
- Thoroughly tested; build the `.mcaddon`; open a PR.

**Assumptions (mine, stated so they can be corrected):**

- "Bedrock 26.3" is the March 2026 release (internal `1.26.3`). Its stable script modules are `@minecraft/server 2.5.0` and `@minecraft/server-ui 2.0.0`. Targeting those makes the add-on load on 26.3 **and** every later version (stable modules are forward compatible). No beta APIs or experiments are required.
- Single-player, Realms and dedicated servers must all work; per-player views in multiplayer.
- Overworld is the primary target. The End is optional. The Nether is excluded (its bedrock ceiling makes a surface LOD meaningless).

**Success criteria:**

1. LOD terrain is drawn from the edge of the player's real (vanilla) terrain out to the configured distance (≤ 32 chunks), matching real heights/colours closely, without holes or overlapping artifacts.
2. The number of fully loaded chunks is not increased for rendering (only short, bounded, optional ticking-area batches for generating never-visited terrain).
3. Script cost stays within a configurable per-tick budget (default ≈ 3 ms); particle spawns within a configurable rate.
4. Everything is configurable in an in-game UI; settings persist.
5. Automated tests cover data encoding, LOD selection, meshing, scheduling, persistence, and an end-to-end simulation with a fake Bedrock runtime, including software-rendered previews that are checked for holes.

## 2. Platform constraints that shape the design

| Constraint | Consequence |
| --- | --- |
| Add-ons cannot change the client render distance or the camera far plane, cannot generate meshes, textures or shaders at runtime. | LOD geometry must be built from primitives the client can position at runtime. |
| Entities are culled ~64 blocks from the camera (entity render distance) and have ≤ 32 synced properties. | Entity-based LOD tiles cannot show terrain 150–500 blocks away and cannot carry per-column colour data. Rejected. |
| Particles are **not** culled by distance (MCPE-128826: particles visible 300+ blocks away at 12-chunk render distance; only fog hides them). Particles accept per-instance Molang variables (position offset, size, colour, lifetime) from scripts, and `Player.spawnParticle` shows them to one player only. | **LOD terrain is rendered as particle quads.** One particle = one LOD face. |
| Script API can only read loaded chunks (`isChunkLoaded`, `getTopmostBlock`, `getBlock`, `getBiome`, `BlockMapColorComponent.tintedColor`). | LOD data comes from (a) chunks the player has loaded anyway (passive capture) and (b) optional short-lived ticking areas that let the real world generator produce unexplored terrain (active generation). |
| `spawnParticle` throws for locations in unloaded chunks. | Emitters are spawned at a point inside the loaded area on the eye→target ray; the particle itself is offset to the far target via `emitter_shape_point.offset`. |
| Particles cannot be removed by script once spawned. | Particles get finite lifetimes and are refreshed on a rolling schedule; stale quads disappear by themselves. `particle_expire_if_in_blocks` lists solid terrain blocks so a LOD quad disappears automatically the moment the client has the real chunk at that spot (self-culling hand-over to vanilla terrain). |
| Default fog ends at the vanilla render distance and would hide all LOD. | The add-on pushes a per-player fog (`/fog push`) with fixed block distances matching the LOD distance (air + weather only; water/lava stay vanilla). |
| QuickJS (no JIT), watchdog on long ticks. | Typed arrays, no per-quad objects, everything time-sliced through a budgeted cooperative scheduler driven by `system.runJob` (background) and `system.runInterval` (per-tick spawning). |

## 3. Architecture

```
┌──────────────────────────── Behavior pack (scripts/main.js) ─────────────────────────────┐
│ bedrock/ (only layer importing @minecraft/server)                                        │
│   BedrockHost: world/dimension/player adapters, commands, forms, events, dyn. properties │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ core/ (pure TypeScript, unit-testable)                                                   │
│   settings  – schema, presets, validation, world + player layers                         │
│   palette   – block colour table (generated from vanilla textures) + tint/style math     │
│   lod/      – ChunkLod (typed arrays + mips), aggregation, codec (region strings)        │
│   cache     – LodStore: LRU memory cache + region persistence + dirty tracking           │
│   sampler   – samples one chunk via the host (generator, time-sliced)                    │
│   planner   – per-player quadtree tile selection (distance, quality, exclusion, hyster.) │
│   mesher    – tile → packed quads (tops, walls, greedy quadtree merge, shading)          │
│   renderer  – per-player tile state, spawn/refresh queue, lifetimes, budgets             │
│   capture   – passive sampling of loaded chunks (edge-first, dirty, stale)               │
│   generator – active generation via ticking areas (batches, timeouts, backoff)          │
│   radius    – detects each player's loaded (vanilla) chunk radius                        │
│   scheduler – cooperative, budgeted task runner; adaptive governor                       │
│   fog, hud, commands, ui-model                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────── Resource pack ────────────────┐
│ particles/lod_top, lod_wall (+ compat variants via subpacks) │
│ textures/particle/dl_lod.png, item icon      │
│ fogs/dl_horizon_<6..32>.json                 │
│ texts/*.lang                                 │
└───────────────────────────────────────────────┘
```

All core modules depend on small interfaces (`HostWorld`, `HostDimension`, `HostPlayer`, `HostClock`), never on `@minecraft/server` directly. The bedrock layer implements them; tests implement them with a fake.

## 4. Data model

### 4.1 Chunk LOD (`ChunkLod`)

- Base resolution `r ∈ {2, 4, 8}` blocks (setting "Sample resolution", default 4) → `n = 16 / r` samples per axis.
- Per sample (typed arrays of length `n²`):
  - `height` (Int16): Y of the top surface (topmost relevant block Y + 1). `NO_DATA = -32768`.
  - `color` (Uint32 0xRRGGBB): colour after biome tint (texture-average palette × tint).
  - `flags` (Uint8): `WATER`, `FOLIAGE`, `SNOW`, `LAVA`, `VOID`.
  - `depth` (Uint8): water depth in blocks (0–63), when water-depth shading is on.
- Mip levels: cell sizes `r, 2r, … 16` computed on insert (`ChunkLod.levels`). All levels of a chunk are views into one `ArrayBuffer` (fewer heap objects for the QuickJS GC to walk).
- `version` (incremented when content changes), `sampledAt` (world tick), `res`.

**Aggregation of 2×2 cells → 1** (used for mips and multi-chunk cells):
- If ≥ 2 children are water → water cell: height = max water height, colour = mean of water children, depth = mean.
- Else land: height = **second highest** of the land children (≈75th percentile; keeps ridges and peaks without letting a single tree raise a whole cell); colour = mean of land children; FOLIAGE/SNOW by majority.
- Missing children are ignored; all missing → `NO_DATA`.

### 4.2 Persistence (world dynamic properties)

- Region = 8×8 chunks. Key: `dl:r:<dim>:<rx>:<rz>` (`dim`: 0 overworld, 2 end).
- Value (string ≤ 32 767 chars): `"L1|<res>|"` + 16 hex chars presence bitmap (64 bits) + base64 payload of present chunks in order.
- Per sample 4 bytes: 9 bits height (Y + 64, 0–511), 16 bits RGB565, 3 bits flags (water/foliage/snow; lava folded into colour), 4 bits depth bucket. Chunk payload `n² × 4` bytes (r=4: 64 B; r=2: 256 B) → max region 22 KB base64 at r=2.
- Regions saved when dirty, throttled (≤ 2 per second), on a budget. Total storage capped by a setting (default 8 MB); when over budget, regions farthest from all players are evicted first.
- Changing the sample resolution invalidates cached data lazily (records with a different `res` are resampled on demand).

## 5. Sampling (`sampler`)

For each sample column `(x0 + r/2, z0 + r/2)`:
1. `dim.getTopmostBlock({x, z})` (heightmap lookup, O(1)).
2. Skip non-occluding decoration (short grass, flowers, ferns, saplings, carpets, rails, torches, crops, snow layers handled specially, etc.) via `block.below()` up to 3 steps, keeping the decoration only for colour mixing where it matters (snow layer → SNOW colour at the ground height).
3. "Vegetation" setting: *Canopy* (default; leaves count → tree silhouettes) or *Ground* (raycast through leaves/logs to ground).
4. Colour: palette[typeId] (generated from vanilla top textures, alpha-weighted average) × tint, where tint = `mapColor.tintedColor / mapColor.color` for tinted blocks (grass, foliage, water — exact biome colormap evaluation by the engine). Unknown blocks fall back to `tintedColor` directly, then to grey.
5. Water: if enabled, `getBlockFromRay(down, includeLiquidBlocks:false)` to measure depth (≤ 48).
6. Any `LocationInUnloadedChunkError`/`undefined` aborts the chunk (retried later).

## 6. LOD selection (`planner`)

Per player, recomputed when the player moved ≥ 8 blocks, every 2 s, or when data/settings changed:

- Inner radius `Rin` (chunks) = detected vanilla loaded radius − `innerOverlap` (default 1) or a manual value. Chunks with `(cx−pcx)² + (cz−pcz)² ≤ Rin²` are **excluded** (real terrain).
- Outer radius `Rout` = min(player distance, world max distance) ≤ 32 chunks.
- Detail function: `cell(d) = clamp(r · 2^⌊log2(d / (r·Q))⌋, r, 64)` where `Q` is the quality factor (Low 8, Medium 12, High 16, Ultra 22, or custom).
- Quadtree over 64-block roots: a node is emitted as a tile when it is entirely outside the exclusion disk and `cell(nearest distance) ≥ node size` (one cell), otherwise it subdivides down to chunk tiles, whose cell size is `cell(center distance)` (≤ 16).
- **Hysteresis**: a tile keeps its previous cell size unless the distance crossed the threshold by > 12 %, preventing LOD flicker while walking.
- **Conservative band** *(added during testing)*: tiles within 2 chunks outside `Rin` use the lowest sample of each cell instead of the aggregated height, so LOD faces next to real terrain never float above it while real chunks stream in.
- Plans are built incrementally (`beginPlan` / `addPlanTile` / `commitPlan`, yielding every 64 tiles); the previous plan keeps rendering until the new one is committed.
- **Adaptive quality**: if the estimated quad count exceeds the player's quad budget, `Q` is reduced in steps until it fits.
- Underground pause: if the player's head has sky light 0 and they are ≥ 16 blocks below the local LOD surface, refreshes stop (LOD invisible anyway); resumes when back on the surface.

## 7. Meshing (`mesher`)

Tile `(x0, z0, N, s)` → packed `Float32Array` of quads (`kind, x, y, z, a, b, r, g, b, fade`):
- **Top** quad per cell at `y = H − δ` (`δ = 0.15`, keeps the particle centre inside the real top block so it self-culls when the chunk loads), half-size `s/2`, axis-aligned horizontal (`emitter_transform_xz`).
- **Wall** billboard (`lookat_y`) where `H − Hmin_neighbour ≥ 1`, from `Hmin − 1` to `H`, where `Hmin` is the lowest *lowest sample* of the 8 neighbours; fills vertical gaps from every horizontal view direction with one quad instead of up to four. *(Refined during testing:)* at spawn time the wall is moved from the cell centre to the cell edge nearest the player, which closes the see-through gaps a centred wall leaves behind terrain steps (measured by the rasteriser: ≤ 38 % sky behind steps → ≤ 0.6 %). *(Refined after review:)* walls are also widened to the cell's apparent width from the player (`s·(|cos|+|sin|)`, up to √2 at 45°), conservative tiles get the same treatment once they are outside the real terrain, and water cells get walls where they stand above lower land (lakes on slopes). Over real terrain walls stay centred and narrow so they self-cull inside the column's blocks. Rasteriser (88–232 blocks): holes 289 → 60 px over five scenes.
- **Greedy quadtree merge**: four equal (height, flags, colour within ΔE tolerance) tops merge into one quad of twice the size, recursively (oceans and plains collapse to a few quads). Squares only, so quad orientation can never be transposed.
- **Shading**: walls × 0.78; relief shading on tops from the height gradient (north-west light, like vanilla maps), style transforms (Natural / Vivid / Cartographic contours / Monochrome elevation / Debug LOD levels), aerial perspective (blend toward sky colour with distance), water depth darkening.
- Mesh results are cached in an LRU keyed by `(tile, s, data versions, style version)` and shared by all players.

## 8. Rendering (`renderer`)

- Per player: `Map<tileKey, TileState{quads, sig, spawnedAt, expiresAt, prio}>`.
- Spawn queue order: (1) tiles whose particles expire within the safety margin, (2) new/changed tiles by priority (distance × view-angle factor, front first), (3) scheduled refreshes.
- Every spawned particle gets `life = refreshInterval + margin` (default 15 s + 5 s); tiles refresh every `refreshInterval`, so copies overlap briefly and never blink. Under load the effective refresh interval stretches automatically (lifetimes follow).
- **Speed-aware lifetimes** *(added during testing)*: a tile's lifetime is capped at the time until its nearest point enters the real-terrain radius at the player's current velocity, plus 1 s (minimum 3 s), so faces ahead of a sprinting or flying player expire as real terrain takes over. Such tiles are not refreshed early: they are looked at again 0.5 s before they expire.
- *(Refined after review:)* the schedule runs on the wall clock (particles age in real seconds on the client; a lagging server has fewer ticks per second) and the spawn share uses the measured tick rate. Refresh entries are keyed by when they become urgent, and a remesh keeps the tile's refresh deadline.
- **Re-sending self-culled faces** *(added after review)*: faces spawned while their chunks were real terrain (or just outside it) self-cull against its blocks. Tiles near the real-terrain edge are watched (4×/s); once a tile is outside the loaded radius (chunk distance, as the game measures it) and farther than its closest approach since its last spawn, its faces are sent again ahead of new tiles, without the grow-in.
- Emitter position: on the eye→face ray at `min(20, ½·distance)` blocks, clamped to world height, computed per face from the current eye position (always inside loaded chunks, also right after a teleport, and inside the view frustum whenever the face is).
- Per-tick global spawn budget shared round-robin between players; per-player quad caps.
- New tiles "grow in" over 0.35 s (size eased from 0 → 1) for polished appearance; refreshes don't animate.
- Day/night: each particle carries brightness `l0` and slope `dl` (per second) computed from time of day, weather and moon; Molang evaluates `clamp(l0 + dl·age)`, giving smooth dusk/dawn transitions without respawning.

## 9. Data acquisition

### 9.1 Passive capture (`capture`)
Chunks loaded around players are sampled in priority order: never-sampled > dirty (block break/place/explosion events in that chunk) > stale (older than "Resample interval") — and nearer the vanilla edge first (those become LOD soonest). Budgeted per tick.

### 9.2 Active generation (`generator`)
For never-sampled chunks inside `Rout` but outside the loaded area:
- Pick the highest-priority missing chunk (mode *Nearest*, *View direction*, or *Balanced*), expand to an aligned `G×G` batch (setting 2–8, default 4).
- `tickingarea add` a `(G+2)²` area (1-chunk margin so the inner chunks finish decoration), named `dl_gen_<i>`. Wait until all inner chunks report `isChunkLoaded`, sample them, `tickingarea remove`. Timeout 30 s → back off that batch exponentially.
- Concurrency 1–3 batches (setting). Never exceeds 100 chunks per area or the 10-area world limit; on "too many ticking areas" it backs off for 5 min and tells operators once.
- Startup removes leftover `dl_gen_*` areas from crashed sessions.
- Optional pauses: while the player is flying/gliding fast, when server tick time is high (governor).
- Uses the real world generator, so seed and generation rules are preserved. Note documented for users: generated chunks are saved to the world like explored chunks.

## 10. Loaded radius detection (`radius`)
Every 3 s per player: for 8 directions binary-search the largest chunk distance with `isChunkLoaded` true; the median is the vanilla radius. Robust against ticking areas or other players. Self-culling (§2) makes small errors harmless.

## 11. Fog
`fogs/dl_horizon_<D>.json` for every `D = 6 … 32` chunks: air `fixed` start ≈ 0.62·end, end = `D·16 − 24` (the stair-stepped chunk edge of the LOD can be ~20 blocks inside `D·16`, so the fog is complete before it); weather start 0.25·end, end 0.7·end. *(Refined after review:)* `D` is the radius the committed plan actually draws, rounded down (smaller than the setting when the face budget cuts the edge), and no fog is pushed when the real terrain already reaches the LOD distance. Pushed per player as `fog @s push dl:horizon_<D> dl_lod` (after `fog @s remove dl_lod`) in the Overworld when LOD is enabled; removed in other dimensions and when disabled. Fog mode setting: *Horizon* (default), *Vanilla* (don't touch fog), *Atmospheric* (start fog earlier for haze).

## 12. Settings

World settings (operators only), persisted in `dl:settings`; player settings in player dynamic property `dl:player`.

| Group | Setting | Range / values | Default |
| --- | --- | --- | --- |
| General | LOD enabled | on/off | on |
| | Max LOD distance | 8–32 chunks | 24 |
| | Quality preset | Low / Medium / High / Ultra / Custom | Medium (auto: Low on mobile low-memory) |
| | Custom quality factor | 6–28 | 12 |
| | Sample resolution | 2 / 4 / 8 blocks | 4 |
| Generation | Mode | Off / Explored only / Generate distant terrain | Generate |
| | Priority | Nearest / View direction / Balanced | Balanced |
| | Batch size | 2–8 chunks | 4 |
| | Concurrent batches | 1–3 | 1 |
| | Pause while flying | on/off | on |
| Updates | Refresh interval | 8–60 s | 15 |
| | Resample interval | 1–60 min | 10 |
| | Track block changes | on/off | on |
| Performance | Script budget | 1–10 ms/tick | 3 |
| | Particle spawns per tick | 10–250 | 60 |
| | Max quads per player | 1 000–16 000 | preset |
| | Adaptive quality | on/off | on |
| | Pause underground | on/off | on |
| Cache | Memory cache | 1 024–32 768 chunks | 8 192 |
| | Persist LOD data | on/off | on |
| | Storage budget | 1–32 MB | 8 |
| Display | Style | Natural / Vivid / Cartographic / Elevation / Debug LOD | Natural |
| | Relief shading | 0–100 % | 60 |
| | Aerial perspective | 0–100 % | 35 |
| | Water depth shading | on/off | on |
| | Vegetation | Canopy / Ground | Canopy |
| | Transition animation | on/off | on |
| | Day/night lighting | on/off | on |
| | Fog mode | Horizon / Vanilla / Atmospheric | Horizon |
| Dimensions | Render The End | on/off | off |
| Player | LOD for me / my distance / my quality / HUD | | on / world max / world / off |

Resource-pack subpacks (pack settings in the game UI): **Standard** (opaque quads, subtle texture), **Smooth** (flat colour, cheapest), **Compatibility** (top faces use `direction_z` with a custom direction instead of `emitter_transform_xz`, for devices where emitter-space faces misbehave).

## 13. UI & commands

- `/dl:horizon [menu|stats|toggle|hud|pregen|clear|selftest|preset|reset] [value]` (custom command, no cheats required; world-changing actions require operator permission). Fallback: `/scriptevent dl:<action> [value]`; `/scriptevent dl:set <key>=<value>` sets any world setting.
- **Horizon Lens** item (shapeless: compass + glass pane) opens the menu on use.
- Menu (ActionForm): Quick presets · My view · World distance & quality · Generation · Updates & performance · Display · Cache & data · Diagnostics. Each page is a ModalForm generated from the settings schema (sliders, dropdowns, toggles, tooltips).
- HUD (optional per player, action bar): quads, tiles, spawn rate, cache, generation queue, ms/tick, radius.
- Self-test: spawns a 4×4 calibration pattern 32 blocks ahead and reports detected capabilities.

## 14. Error handling

- Every host call is wrapped; failures are counted per category, logged with rate limiting, and never break the scheduler.
- Unloaded-chunk errors abort the current unit and requeue it with backoff.
- Corrupt region strings are discarded and resampled.
- Players leaving/dimension changes clear per-player state; ticking areas are always removed (on completion, timeout, settings change, and next startup).

## 15. Testing

1. Unit tests (node:test + tsx): codec round-trip, aggregation rules, palette/tint math, planner tiling (coverage, no overlap, exclusion, hysteresis), mesher (quad counts, merge correctness, walls), renderer scheduling (no expiry gaps, budget adherence, priorities), settings validation, radius detection.
2. End-to-end simulation: the bundled `main.js` runs against a fake `@minecraft/server` (procedural terrain with biomes/water/trees, chunk loading around players, ticking areas via command parsing, client particle store with lifetimes and `expire_if_in_blocks`, fog stack, dynamic properties with size limits, virtual clock, `runJob`/`runInterval` semantics). Scenarios: single player walking/flying, teleports, dimension changes, multiplayer, settings changes, world reload (persistence).
3. Software rasterizer renders what the fake client would show (LOD particles + vanilla chunks) from the player's eye and compares coverage/depth against a ground-truth heightfield render; tests assert no holes in the LOD ring and bounded depth error. Preview PNGs are kept as artefacts.
4. Static validation: all JSON parses; manifests, UUIDs, particle/fog/item schemas sanity-checked; every referenced texture/lang key exists; TypeScript type-checks against the official 2.5.0 / 2.0.0 typings. `npm run validate` repeats the archive-level checks on a freshly packed `.mcaddon` (and checks the committed one is identical).
5. QuickJS *(added during testing)*: the shipped bundle must load as an ES module in QuickJS, and a 1 200-tick run of the real core interpreted by QuickJS must keep the per-tick averages within budget and 99.9 % of scheduler steps under 5 ms (limits scaled by a calibration workload on slower machines).

## 16. Risks

| Risk | Mitigation |
| --- | --- |
| Behaviour of `emitter_transform_xz` on some devices | Compatibility subpack using `direction_z` + custom direction. |
| Client particle caps on low-end devices | Per-player quad budget, presets by memory tier/platform, adaptive quality, HUD. |
| Vibrant Visuals (deferred) may light/fog particles differently | Detected via `player.graphicsMode`; noted in HUD/self-test. |
| Packet volume on servers | Spawn rate cap, refresh interval setting, per-player budgets. |
| World growth from generation | Explicit setting with explanation; "Explored only" mode. |
| Cannot run Bedrock in CI | Fake-runtime simulation + rasterised previews + type-checking; in-game self-test command for users. |
