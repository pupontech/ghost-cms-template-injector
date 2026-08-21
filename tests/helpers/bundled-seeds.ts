import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Preset } from '../../src/preset-schema';

/**
 * Test accessor for the packaged (read-only) seed collection. Reads the same
 * file the extension ships, so tests validate the real artifact.
 */
export function bundledSeedPresets(): Preset[] {
  const path = fileURLToPath(new URL('../../presets/presets.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Preset[];
}
