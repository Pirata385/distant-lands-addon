// Builds the behavior/resource packs into build/ and (with --pack) zips them
// into dist/DistantLands-v<version>.mcaddon.
import { build as esbuild } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export const BP_NAME = 'DistantLands_BP';
export const RP_NAME = 'DistantLands_RP';

/** Files that live next to pack sources but must not ship. */
const isShippable = (src) => !/\.(md|psd|xcf|kra)$/i.test(src) && !src.includes(`${'/'}.`);

export async function build({ outDir = join(root, 'build'), minify = false } = {}) {
  const bpDir = join(outDir, BP_NAME);
  const rpDir = join(outDir, RP_NAME);
  rmSync(bpDir, { recursive: true, force: true });
  rmSync(rpDir, { recursive: true, force: true });
  cpSync(join(root, 'packs', 'behavior_pack'), bpDir, { recursive: true, filter: isShippable });
  cpSync(join(root, 'packs', 'resource_pack'), rpDir, { recursive: true, filter: isShippable });

  await esbuild({
    entryPoints: [join(root, 'src', 'main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    platform: 'neutral',
    external: ['@minecraft/server', '@minecraft/server-ui'],
    outfile: join(bpDir, 'scripts', 'main.js'),
    minify,
    legalComments: 'none',
    charset: 'utf8',
    banner: { js: `// Distant Lands v${pkg.version} - generated bundle, edit src/ instead.` },
    logLevel: 'warning',
  });
  return { outDir, bpDir, rpDir, version: pkg.version };
}

function addDir(files, dir, prefix) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const key = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) addDir(files, full, key);
    else files[key] = new Uint8Array(readFileSync(full));
  }
}

/** Zips both packs into a single .mcaddon. Deterministic (fixed timestamps, sorted entries). */
export async function pack(result, distDir = join(root, 'dist')) {
  mkdirSync(distDir, { recursive: true });
  const files = {};
  addDir(files, result.bpDir, BP_NAME);
  addDir(files, result.rpDir, RP_NAME);
  const zip = zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
  const file = join(distDir, `DistantLands-v${result.version}.mcaddon`);
  writeFileSync(file, zip);
  return file;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await build({ minify: process.argv.includes('--minify') });
  console.log(`built ${result.bpDir}\nbuilt ${result.rpDir}`);
  if (process.argv.includes('--pack')) {
    const file = await pack(result);
    console.log(`packed ${file} (${statSync(file).size} bytes)`);
  }
}
