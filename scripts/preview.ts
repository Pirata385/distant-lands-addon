/**
 * Writes simulated comparison images for the docs: ground truth (all terrain at full detail) vs. what a player sees
 * with Distant Lands (real chunks + LOD particles), rendered by the test rasteriser against the fake runtime.
 * Run: npm run preview
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PNG_DIR, composeComparison } from '../test/render/compose';

mkdirSync(PNG_DIR, { recursive: true });
await composeComparison(join(import.meta.dirname, '..', 'docs', 'images'));
console.log('previews written to docs/images');
