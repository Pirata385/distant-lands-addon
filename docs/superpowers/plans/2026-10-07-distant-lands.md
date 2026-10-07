# Distant Lands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Bedrock 26.3 add-on (`.mcaddon`) that renders Distant-Horizons-style LOD terrain with particle quads out to 32 chunks, fed by passive capture and optional ticking-area generation.

**Architecture:** Pure TypeScript core (`src/core`) behind small host interfaces; a thin Bedrock adapter (`src/bedrock`) is the only code importing `@minecraft/server`. esbuild bundles to `packs/behavior_pack/scripts/main.js`. Tests run the core directly and the bundled entry against a fake runtime.

**Tech Stack:** TypeScript 5, esbuild, node:test + tsx, Python 3 + Pillow for asset generation, `@minecraft/server` 2.5.0 / `@minecraft/server-ui` 2.0.0 typings.

**Spec:** `docs/superpowers/specs/2026-10-07-distant-lands-design.md`

## Global Constraints

- Script modules: `@minecraft/server` **2.5.0**, `@minecraft/server-ui` **2.0.0** (stable in 1.26.3). No beta APIs, no experiments.
- Manifests: `format_version` 2, `min_engine_version` `[1, 26, 0]`.
- Particle files `format_version` `"1.10.0"`; fog files `"1.16.100"`; item/recipe files ≤ `"1.21.60"`.
- Namespace `dl`; identifiers `dl:lod_top`, `dl:lod_wall`, `dl:horizon_<D>`, `dl:horizon_lens`.
- Max LOD distance hard cap **32 chunks**.
- Bundle target ES2020, no Node built-ins in `src/`.
- Hot paths use typed arrays; no per-quad object allocation.
- Every host call is wrapped (`try/catch`), errors never escape the scheduler.

## Review Focus

1. Player standing in a chunk that is not loaded yet (teleport, respawn, world join): `spawnParticle`/`isChunkLoaded` throw or return false → renderer must skip the tick and retry, never crash. *(Task 9 test `skips spawning when host throws unloaded`.)*
2. World already has 10 ticking areas (user's own): `tickingarea add` fails → generator backs off 5 min and notifies operators once; capture keeps working. *(Task 10 test `backs off when ticking area limit reached`.)*
3. Region string near the 32 767-char limit (resolution 2 with 64 chunks): codec must never produce an over-long value. *(Task 3 test `max region at res 2 fits property limit`.)*
4. Form shown while chat is open (`UserBusy`) and form value arrays containing `undefined` for labels/headers → retry and index-safe parsing. *(Task 12 test `parses modal values with label slots`.)*
5. Settings changed mid-flight (resolution, generation off, distance down): queued work referencing old settings is dropped, ticking areas removed, fog re-pushed. *(Task 11 sim test `settings change mid generation cleans up`.)*

---

### Task 1: Scaffold build, test and pack skeleton

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `scripts/build.mjs`, `packs/behavior_pack/manifest.json`, `packs/resource_pack/manifest.json`, `src/main.ts` (stub), `test/unit/smoke.test.ts`.

**Interfaces:** Produces npm scripts `build`, `test`, `typecheck`, `pack` (build + zip to `dist/DistantLands-<version>.mcaddon`).

- [ ] Write `smoke.test.ts` asserting `npm run build` output file exists and contains `@minecraft/server` import.
- [ ] Implement build script (esbuild bundle, externals `@minecraft/server`, `@minecraft/server-ui`, copy packs to `build/`, zip).
- [ ] Run `npm test`, `npm run typecheck` → pass. Commit.

### Task 2: Palette (vanilla texture averages) and colour math

**Files:** Create `scripts/gen-palette.py`, `src/core/palette-data.ts` (generated), `src/core/palette.ts`, `test/unit/palette.test.ts`.

**Interfaces:** Produces `baseColor(typeId: string): number | undefined` (0xRRGGBB), `applyTint(base: number, tinted: RGB, mapBase: RGB): number`, `mix/scale/luma` helpers, `styleColor(style, color, height, flags, level): number`, `isDecoration(typeId)`, `isFoliage(typeId)`, `EXPIRE_BLOCKS: string[]`.

- [ ] Tests: `grass_block` base is grey-ish (tinted at runtime), `sand` is yellowish, unknown ids → `undefined`; tint ratio math; styles preserve channel bounds; decoration set includes `short_grass`, excludes `grass_block`.
- [ ] Implement generator (alpha-weighted mean of top texture, aliases for renamed ids) and module. Run tests. Commit.

### Task 3: ChunkLod, aggregation, region codec

**Files:** Create `src/core/lod/chunk-lod.ts`, `src/core/lod/aggregate.ts`, `src/core/lod/codec.ts`, tests.

**Interfaces:** `class ChunkLod { res; n; height: Int16Array; color: Uint32Array; flags: Uint8Array; depth: Uint8Array; version; sampledAt; mips: Level[]; buildMips(); cell(size, i, j): CellRef }`, `aggregate4(...)`, `encodeRegion(chunks: (ChunkLod|undefined)[64], res): string`, `decodeRegion(s): {res, chunks}`; flags `F_WATER=1, F_FOLIAGE=2, F_SNOW=4, F_VOID=8`; `NO_DATA=-32768`.

- [ ] Tests: aggregation (water majority, second-highest land height, missing children), mips sizes, codec round-trip with quantisation tolerance, corrupt input → throws `CodecError`, `max region at res 2 fits property limit`.
- [ ] Implement. Commit.

### Task 4: LodStore (memory LRU + persistence + eviction)

**Files:** Create `src/core/util/lru.ts`, `src/core/store.ts`, tests.

**Interfaces:** `interface KV { get(k): string|undefined; set(k, v|undefined); keys(): string[]; bytes(): number }`, `class LodStore { get(dim, cx, cz): ChunkLod|undefined; put(dim, cx, cz, lod); markDirty(dim,cx,cz); isDirty(...); version(dim,cx,cz): number; flush(budget): number; evictFar(points); stats() }`.

- [ ] Tests: LRU bound, lazy region load from KV, flush writes only dirty regions, eviction farthest-first when over storage budget, resolution mismatch treated as stale.
- [ ] Implement. Commit.

### Task 5: Settings schema, presets, validation

**Files:** Create `src/core/settings.ts`, test.

**Interfaces:** `SETTINGS_SCHEMA: SettingDef[]` (key, group, type `int|bool|enum`, min/max/step/options, default, label key, tooltip key, scope `world|player`), `class Settings { world; player(id); effective(id): Effective; applyPreset(name); load/save via KV }`, presets `potato|low|medium|high|ultra`.

- [ ] Tests: defaults valid, clamping, unknown keys dropped, player distance ≤ world max ≤ 32, preset application, JSON round-trip.
- [ ] Implement. Commit.

### Task 6: Host interfaces and chunk sampler

**Files:** Create `src/core/types.ts`, `src/core/sampler.ts`, `test/fakes/terrain.ts`, test.

**Interfaces:** `HostDimension { id; minY; maxY; isChunkLoaded(x,z); topmost(x,z): HostBlock|undefined; rayDown(x,y,z,max): number|undefined; }`, `HostBlock { typeId; y; below(): HostBlock|undefined; mapColor(): {base: RGB, tinted: RGB}|undefined }`, `sampleChunk(dim, cx, cz, res, opts): Generator<void, ChunkLod|null>`.

- [ ] Tests (fake terrain): heights match generator, decorations skipped, snow/water flags, depth, unloaded → null, vegetation Ground mode ignores leaves.
- [ ] Implement. Commit.

### Task 7: Planner (quadtree tile selection)

**Files:** Create `src/core/planner.ts`, test.

**Interfaces:** `planTiles(input: {px, pz, rinChunks, routChunks, res, quality, prev?: Map<string, number>}): Tile[]` with `Tile {key, x0, z0, size, cell, dist}`; `cellSizeFor(d, res, q)`; `estimateQuads(tiles)`.

- [ ] Tests: tiles never overlap, cover every non-excluded chunk within Rout, no tile inside exclusion disk, cell sizes monotonic with distance, hysteresis keeps level within ±12 % band, Rout ≤ 32 chunks.
- [ ] Implement. Commit.

### Task 8: Mesher

**Files:** Create `src/core/mesher.ts`, test.

**Interfaces:** `meshTile(tile, lookup: CellLookup, style: StyleParams): Float32Array` (stride 10: kind, x, y, z, a, b, r, g, b, fade), `QUAD_STRIDE=10`, `K_TOP=0`, `K_WALL=1`; `CellLookup.cell(size, x, z): {h, color, flags, depth} | null`.

- [ ] Tests: flat area merges to one quad, step creates wall with correct height, water has no walls, tops at `H − 0.15`, missing data skipped, colours within [0,1].
- [ ] Implement. Commit.

### Task 9: Lighting and renderer

**Files:** Create `src/core/lighting.ts`, `src/core/renderer.ts`, tests.

**Interfaces:** `brightness(timeOfDay, rain, thunder, moonPhase): {l0, dl}`; `class PlayerView { setTiles(tiles, meshes); pump(budget, now, host: ParticleSink): number; stats() }`; `ParticleSink.spawn(effect: 'dl:lod_top'|'dl:lod_wall', emitter: Vec3, vars: Float64Array/obj)`.

- [ ] Tests: no tile expires before refresh under nominal load, budget respected, front-first priority, emitter within 20 blocks of eye and inside world height, `skips spawning when host throws unloaded`, lifetimes stretch under overload.
- [ ] Implement. Commit.

### Task 10: Radius detection, passive capture, active generation

**Files:** Create `src/core/radius.ts`, `src/core/capture.ts`, `src/core/generator.ts`, tests.

**Interfaces:** `detectRadius(dim, cx, cz, max): number`; `class Capture { tick(budget) }`; `class Generator { tick(now); cancelAll(); } ` using `host.command(dim, cmd): boolean`.

- [ ] Tests: median radius with noisy directions, capture prefers edge/dirty chunks, generator batches/margins/timeouts, `backs off when ticking area limit reached`, startup cleanup commands issued.
- [ ] Implement. Commit.

### Task 11: Scheduler, governor, app orchestration, fog, HUD

**Files:** Create `src/core/scheduler.ts`, `src/core/fog.ts`, `src/core/hud.ts`, `src/core/app.ts`, tests.

**Interfaces:** `class Scheduler { add(task: Task); runFor(ms) }`; `class App { constructor(host: Host); start(); onPlayerJoin/Leave/DimChange; onBlockChanged; settingsChanged() }`.

- [ ] Tests: budget adherence, task starvation avoided, fog command sequence per dimension, `settings change mid generation cleans up`.
- [ ] Implement. Commit.

### Task 12: Bedrock host, UI, commands, entry point

**Files:** Create `src/bedrock/host.ts`, `src/bedrock/ui.ts`, `src/bedrock/commands.ts`, `src/main.ts`, `test/unit/ui.test.ts`.

- [ ] Tests: `parses modal values with label slots`, command argument parsing, permission gating.
- [ ] Implement; `npm run typecheck` against official typings passes. Commit.

### Task 13: Pack assets

**Files:** `scripts/gen-assets.py` (textures, icons, fogs), `packs/resource_pack/particles/*.json`, subpacks, items, recipe, lang files.

- [ ] Static validation test: JSON parses, ids/namespaces, textures exist, lang keys used by code exist, fog ids for every distance step. Commit.

### Task 14: End-to-end simulation with fake runtime

**Files:** `test/fakes/mc-server.ts`, `test/fakes/mc-server-ui.ts`, `test/sim/*.test.ts`.

- [ ] Scenarios: walk, fly, teleport, dimension change, two players, reload persistence, settings change; invariants: no exceptions, budgets, ticking areas cleaned, LOD coverage reaches target. Commit.

### Task 15: Software rasteriser and artifact checks

**Files:** `test/render/raster.ts`, `test/render/preview.test.ts`, `scripts/preview.mjs`.

- [ ] Assert hole ratio in LOD ring < 1 % and median depth error < 2 blocks vs ground truth; write PNG previews. Commit.

### Task 16: Docs, build, PR

- [ ] README (install, usage, settings, limitations), build `.mcaddon`, final full test run, push, open PR.
