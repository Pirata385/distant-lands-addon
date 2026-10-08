/** English texts. `npm run assets` writes them to the packs' texts/en_US.lang. */

export const PACK = {
  'pack.name': 'Distant Lands',
  'pack.description': 'Distant Horizons-style LOD terrain: see up to 32 chunks with lightweight far terrain.',
};

export const SETTINGS: Record<string, [label: string, tip: string, options?: Record<string, string>]> = {
  enabled: ['LOD rendering', 'Master switch for distant terrain on this world.'],
  maxDistance: ['Max LOD distance (chunks)', 'How far distant terrain is drawn. Real terrain still uses your video render distance.'],
  quality: [
    'LOD quality',
    'How quickly detail drops with distance. Higher keeps finer cells further out and costs more particles.',
    { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra', custom: 'Custom factor' },
  ],
  qualityFactor: ['Custom quality factor', 'Used when quality is Custom. 12 = Medium, 16 = High, 22 = Ultra.'],
  sampleRes: [
    'Sample resolution',
    'Blocks between terrain samples. Finer samples look better near the edge but take longer to collect and store.',
    { '2': '2 blocks (fine)', '4': '4 blocks (balanced)', '8': '8 blocks (fast)' },
  ],
  renderEnd: ['Render The End', 'Also draw distant terrain in The End.'],
  genMode: [
    'Data source',
    'Generate uses temporary ticking areas so the real world generator creates unexplored terrain (saved to the world like explored chunks). Explored only never loads extra chunks.',
    { off: 'Off (use cached data)', explored: 'Explored terrain only', generate: 'Generate distant terrain' },
  ],
  genPriority: [
    'Generation priority',
    'Which missing terrain is generated first.',
    { nearest: 'Nearest first', view: 'Where you look', balanced: 'Balanced' },
  ],
  genBatch: ['Generation batch (chunks)', 'Side length of each generated batch. Bigger batches are faster but load more chunks at once.'],
  genConcurrency: ['Concurrent batches', 'Batches generated at the same time (each uses one ticking area).'],
  genPauseFlying: ['Pause generation while flying', 'Avoid extra chunk loading while flying or gliding.'],
  refreshSeconds: ['Refresh interval (s)', 'Distant terrain is re-sent on this cycle. Longer is cheaper; shorter adapts faster.'],
  resampleMinutes: ['Resample interval (min)', 'How old LOD data of loaded chunks may get before it is sampled again.'],
  trackBlockChanges: ['Track block changes', 'Re-sample chunks where blocks are broken, placed or exploded.'],
  budgetMs: ['Script budget (ms/tick)', 'Maximum script time per tick for background work.'],
  spawnsPerTick: ['Particle spawns per tick', 'Shared by all players. Higher fills the horizon faster.'],
  maxQuads: ['Max LOD faces per player', 'Upper bound of distant-terrain faces. Adaptive quality lowers detail to stay under it; without it, the farthest terrain is left out.'],
  adaptive: ['Adaptive quality', 'Automatically lowers detail when the face budget is exceeded and raises it again when there is room.'],
  pauseUnderground: ['Pause underground', 'Stop refreshing distant terrain while you are deep underground.'],
  memoryChunks: ['Memory cache (chunks)', 'LOD chunks kept in memory. Raised automatically when the players\' LOD distances need more.'],
  persist: ['Save LOD data in the world', 'Keeps collected distant terrain between sessions.'],
  storageMB: ['Storage budget (MB)', 'Far-away LOD data is removed beyond this size. Data within the players\' LOD distance is always kept.'],
  style: [
    'Terrain style',
    'How distant terrain is coloured.',
    { natural: 'Natural', vivid: 'Vivid', carto: 'Cartographic (contours)', elevation: 'Elevation map', debug: 'Debug: LOD levels' },
  ],
  relief: ['Relief shading (%)', 'Map-like shading of slopes.'],
  aerial: ['Aerial perspective (%)', 'Distant terrain fades toward the sky colour.'],
  waterDepth: ['Water depth shading', 'Deeper water looks darker (one extra check per water sample).'],
  vegetation: ['Vegetation', 'Show tree canopies or the ground below them.', { canopy: 'Tree canopy', ground: 'Ground' }],
  transitions: ['Transition animation', 'New or changed distant terrain grows in smoothly.'],
  dayNight: ['Day/night lighting', 'Distant terrain follows the time of day and weather.'],
  fogMode: [
    'Fog',
    'Horizon pushes the fog to the LOD distance. Vanilla leaves the fog alone (distant terrain may be hidden).',
    { horizon: 'Horizon', vanilla: 'Vanilla', atmospheric: 'Atmospheric haze' },
  ],
  pEnabled: ['Show distant terrain for me', 'Turn LOD off just for you.'],
  pDistance: ['My LOD distance (chunks)', 'Your own limit (the world maximum still applies).'],
  pQuality: [
    'My LOD quality',
    'Override the world quality on your device.',
    { world: 'Use world setting', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' },
  ],
  pQuads: ['My max LOD faces', 'Lower this on weaker devices.'],
  pHud: ['Show LOD statistics', 'Action bar with faces, tiles, cache and timing.'],
};

export const GROUPS: Record<string, string> = {
  general: 'Distance & quality',
  generation: 'Terrain generation',
  updates: 'Updates',
  performance: 'Performance',
  cache: 'Cache & storage',
  display: 'Display',
  player: 'My view',
};

export const PAGES: Record<string, string> = {
  mine: 'My view',
  toggle: 'Toggle LOD for me',
  presets: 'Quick presets',
  general: 'Distance & quality',
  generation: 'Terrain generation',
  performance: 'Updates & performance',
  display: 'Display',
  cache: 'Cache & data',
  diagnostics: 'Diagnostics',
};

export const PRESETS: Record<string, string> = {
  potato: 'Potato (12 chunks, minimal)',
  low: 'Low (16 chunks)',
  medium: 'Medium (24 chunks)',
  high: 'High (28 chunks)',
  ultra: 'Ultra (32 chunks)',
};

export const UI: Record<string, string> = {
  'dl.ui.title': 'Distant Lands',
  'dl.ui.status': 'LOD: %s\nDistance: %s chunks (vanilla radius %s)\nFaces: %s   Cached chunks: %s   Generated: %s',
  'dl.ui.status_unknown': 'Distant terrain is starting up...',
  'dl.ui.save': 'Save',
  'dl.ui.presets_body': 'Presets change distance, quality, generation and performance settings for the whole world.',
  'dl.ui.cache_body': 'Stored regions: %s (%s KB).',
  'dl.ui.cache_settings': 'Cache settings',
  'dl.ui.pregen': 'Pre-generate around me',
  'dl.ui.clear': 'Clear LOD data',
  'dl.ui.clear_confirm': 'Delete all stored distant-terrain data? It will be collected again.',
  'dl.ui.cancel': 'Cancel',
  'dl.ui.hud_on': 'Show statistics HUD',
  'dl.ui.hud_off': 'Hide statistics HUD',
  'dl.ui.selftest': 'Run self-test',
  'dl.msg.enabled': '[Distant Lands] Distant terrain enabled for you.',
  'dl.msg.disabled': '[Distant Lands] Distant terrain disabled for you.',
  'dl.msg.saved': '[Distant Lands] Saved (%s changed).',
  'dl.msg.preset': '[Distant Lands] Preset applied: %s.',
  'dl.msg.cleared': '[Distant Lands] LOD data cleared.',
  'dl.msg.pregen': '[Distant Lands] Generating distant terrain within %s chunks of you for the next 10 minutes.',
  'dl.msg.pregen_failed': '[Distant Lands] Cannot pre-generate here (%s chunks).',
  'dl.msg.op_only': '[Distant Lands] Only operators can change world settings.',
  'dl.msg.form_error': '[Distant Lands] Could not read the form, nothing was changed.',
  'dl.msg.selftest': '[Distant Lands] Look ahead: a 4x4 colour grid with walls should appear for 15 seconds. If you see nothing, try the Compatibility subpack.',
  'dl.msg.reset': '[Distant Lands] World settings reset to defaults.',
  'dl.msg.set': '[Distant Lands] %s = %s',
  'dl.msg.set_usage': '[Distant Lands] Usage: /scriptevent dl:set <setting>=<value>',
  'dl.msg.usage': '[Distant Lands] Actions: %s',
  'dl.msg.storage_small': '[Distant Lands] The storage budget is too small for the current LOD distance. Nearby LOD data is kept anyway; raise the storage budget or lower the distance.',
  'dl.msg.ticking_limit': '[Distant Lands] The world has no free ticking area (limit 10). Distant terrain generation pauses for 5 minutes; explored terrain still updates.',
};

export const ITEMS: Record<string, string> = {
  'item.dl:horizon_lens.name': 'Horizon Lens',
};
