/**
 * Distant Lands — Distant Horizons-style LOD terrain for Minecraft Bedrock 26.3+.
 * Entry point: wires the engine-agnostic core (src/core) to the Script API.
 */
import { Dimension, Player, system, Vector3, world } from '@minecraft/server';
import { App } from './core/app';
import { dimensionIndex } from './core/types';
import { BedrockHost } from './bedrock/host';
import { handleAction, registerCommands } from './bedrock/commands';
import { openMenu, UiContext } from './bedrock/ui';

const ITEM_ID = 'dl:horizon_lens';

let ctx: UiContext | undefined;
let jobRunning = false;

system.beforeEvents.startup.subscribe((ev) => {
  try {
    registerCommands(ev.customCommandRegistry, (player, action, value) => {
      if (ctx) handleAction(ctx, player, action, value);
    });
  } catch (e) {
    console.warn(`[Distant Lands] custom command unavailable, use /scriptevent dl:menu (${String(e)})`);
  }
});

world.afterEvents.worldLoad.subscribe(() => boot());
// Fallback for script reloads where worldLoad has already fired.
system.runTimeout(() => boot(), 40);

function capabilities(host: BedrockHost, p: Player): Record<string, string | number | boolean> {
  const w = host.wrapPlayer(p);
  return {
    'script api': '@minecraft/server 2.5.0',
    'graphics mode': w.graphicsMode() ?? '?',
    'device max render distance': w.maxRenderDistance() ?? '?',
    'memory tier': w.memoryTier() ?? '?',
  };
}

function boot(): void {
  if (ctx) return;
  let app: App;
  let host: BedrockHost;
  try {
    host = new BedrockHost();
    app = new App(host);
    app.start();
  } catch (e) {
    console.error(`[Distant Lands] failed to start: ${e instanceof Error ? e.stack : String(e)}`);
    return;
  }
  ctx = { app, host, capabilities: (p) => capabilities(host, p) };
  const c = ctx;

  world.afterEvents.playerSpawn.subscribe((ev) => {
    if (ev.initialSpawn) app.onPlayerJoin(host.wrapPlayer(ev.player));
  });
  world.afterEvents.playerLeave.subscribe((ev) => {
    app.onPlayerLeave(ev.playerId);
    host.forgetPlayer(ev.playerId);
  });
  world.afterEvents.playerDimensionChange.subscribe((ev) => app.onDimensionChange(host.wrapPlayer(ev.player)));

  const changed = (dim: Dimension, at: Vector3) => app.onBlockChanged(dimensionIndex(dim.id), at.x, at.z);
  world.afterEvents.playerBreakBlock.subscribe((ev) => changed(ev.block.dimension, ev.block.location));
  world.afterEvents.playerPlaceBlock.subscribe((ev) => changed(ev.block.dimension, ev.block.location));
  world.afterEvents.pistonActivate.subscribe((ev) => changed(ev.dimension, ev.block.location));
  world.afterEvents.explosion.subscribe((ev) => {
    const seen = new Set<string>();
    for (const b of ev.getImpactedBlocks()) {
      const key = `${b.x >> 4},${b.z >> 4}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changed(ev.dimension, b.location);
    }
  });
  world.afterEvents.weatherChange.subscribe((ev) => app.onWeather(dimensionIndex(ev.dimension), ev.newWeather));
  world.afterEvents.itemUse.subscribe((ev) => {
    if (ev.itemStack.typeId === ITEM_ID) void openMenu(c, ev.source);
  });
  system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (!ev.id.startsWith('dl:')) return;
    // A player running /scriptevent is the source; for NPC dialogue it is the initiator.
    const src = ev.sourceEntity instanceof Player ? ev.sourceEntity : ev.initiator instanceof Player ? ev.initiator : undefined;
    handleAction(c, src, ev.id, ev.message);
  });
  system.beforeEvents.shutdown.subscribe(() => {
    try {
      app.store.flush(Infinity);
    } catch {
      // Restricted mode may refuse writes; data was flushed periodically anyway.
    }
  });

  system.runInterval(() => {
    app.tick();
    runBackground(app);
  }, 1);
}

/** Runs this tick's share of background work as a system job (falls back to inline execution). */
function runBackground(app: App): void {
  if (jobRunning) return;
  jobRunning = true;
  try {
    system.runJob(backgroundJob(app));
  } catch {
    jobRunning = false;
    const g = app.backgroundSlice();
    while (!g.next().done);
  }
}

function* backgroundJob(app: App): Generator<void, void, void> {
  try {
    yield* app.backgroundSlice();
  } finally {
    jobRunning = false;
  }
}
