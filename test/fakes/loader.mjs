// Node module-resolution hook: maps the Minecraft script modules to the fakes so the production bundle runs in Node.
const MAP = {
  '@minecraft/server': new URL('./mc-server.ts', import.meta.url).href,
  '@minecraft/server-ui': new URL('./mc-server-ui.ts', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (specifier in MAP) return { url: MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}
