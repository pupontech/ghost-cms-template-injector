import { describe, expect, it, vi } from 'vitest';
import { PRESET_SCHEMA_VERSION, validatePreset, type Preset } from '../../src/preset-schema';
import { importPresets } from '../../src/preset-store';
import {
  createOrUpdatePreset,
  deletePreset,
  exportPresetsToString,
  importPresetsFromString,
  listViewPresets,
  type OptionsRuntime,
} from '../../src/options-crud';
import { bundledSeedPresets } from '../helpers/bundled-seeds';

function seed(id: string, extra: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id,
    name: `Name ${id}`,
    content: { source: 'inline-html', mode: 'replace', html: '<p>x</p>' },
    ...extra,
  };
}

/** In-memory OptionsRuntime that faithfully models the Phase-2 preset-store
 *  contract: validation is delegated to validatePreset/importPresets (so the
 *  controller's failure paths mirror production), and `loadPresets` returns the
 *  merged defaults + overrides exactly like preset-store.listPresets(). */
function makeRuntime(initial: Preset[] = []): {
  rt: OptionsRuntime;
  store: { presets: Preset[] };
} {
  const defaults = bundledSeedPresets();
  const store = { presets: [...initial] };
  const rt: OptionsRuntime = {
    loadPresets: vi.fn(async () => {
      const overrideById = new Map(store.presets.map((p) => [p.id, p]));
      const seen = new Set<string>();
      const merged: Preset[] = [];
      for (const preset of defaults) {
        if (seen.has(preset.id)) continue;
        seen.add(preset.id);
        merged.push(overrideById.get(preset.id) ?? preset);
      }
      for (const preset of store.presets) {
        if (seen.has(preset.id)) continue;
        seen.add(preset.id);
        merged.push(preset);
      }
      return merged;
    }),
    loadBundledDefaults: vi.fn(async () => defaults),
    savePreset: vi.fn(async (input: unknown) => {
      const preset = validatePreset(input); // throws before any write
      const idx = store.presets.findIndex((p) => p.id === preset.id);
      if (idx >= 0) store.presets[idx] = preset;
      else store.presets.push(preset);
      return preset;
    }),
    importPresetsIntoStore: vi.fn(async (serialized: string) => {
      const presets = importPresets(serialized); // size-bounded + validated
      store.presets = presets;
      return presets;
    }),
    exportPresets: vi.fn((presets: Preset[]) =>
      JSON.stringify({ kind: 'ghost-preset-toolbar-presets', presets }),
    ),
  };
  return { rt, store };
}

describe('listViewPresets — read + seeded flag', () => {
  it('flags a bundled default as seeded when unedited', async () => {
    const { rt } = makeRuntime();
    const views = await listViewPresets(rt);
    expect(views.length).toBeGreaterThan(0);
    const software = views.find((v) => v.id === 'software-review');
    expect(software?.seeded).toBe(true);
  });

  it('marks an edited seed as not seeded and surfaces the new name', async () => {
    const edited = seed('software-review', { name: 'Edited Review' });
    const { rt } = makeRuntime([edited]);
    const views = await listViewPresets(rt);
    const v = views.find((x) => x.id === 'software-review');
    expect(v?.seeded).toBe(false);
    expect(v?.name).toBe('Edited Review');
  });

  it('carries description/group/icon fields through for rendering as text', async () => {
    const { rt } = makeRuntime([seed('u1', { description: 'D', ui: { group: 'G', icon: '🙂' } })]);
    const views = await listViewPresets(rt);
    const v = views.find((x) => x.id === 'u1');
    expect(v?.description).toBe('D');
    expect(v?.group).toBe('G');
    expect(v?.icon).toBe('🙂');
  });
});

describe('createOrUpdatePreset — validated create/update', () => {
  it('rejects an invalid preset and reports the error without throwing', async () => {
    const { rt } = makeRuntime();
    const outcome = await createOrUpdatePreset(rt, {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: 'bad',
      name: 'Bad',
      content: { source: 'inline-html', mode: 'append' as never, html: '<p>x</p>' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/append/);
    expect(outcome.preset).toBeUndefined();
  });

  it('persists a valid new preset and returns it', async () => {
    const { rt, store } = makeRuntime();
    const outcome = await createOrUpdatePreset(rt, seed('new-one'));
    expect(outcome.ok).toBe(true);
    expect(outcome.preset?.id).toBe('new-one');
    expect(store.presets.map((p) => p.id)).toContain('new-one');
  });

  it('replaces an existing preset in place (upsert by id)', async () => {
    const { rt, store } = makeRuntime([seed('u1', { name: 'Old' })]);
    await createOrUpdatePreset(rt, seed('u1', { name: 'New' }));
    const stored = store.presets.filter((p) => p.id === 'u1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('New');
  });
});

describe('deletePreset — override-set rewrite (no bundled mutation)', () => {
  it('removes a user-only preset from the override set', async () => {
    const { rt, store } = makeRuntime([seed('user-only')]);
    await deletePreset(rt, 'user-only');
    expect(store.presets.map((p) => p.id)).not.toContain('user-only');
  });

  it('reverts an edited seed back to the bundle (drops only the override)', async () => {
    const { rt, store } = makeRuntime([seed('software-review', { name: 'Edited' })]);
    await deletePreset(rt, 'software-review');
    // The override is gone; the bundled seed is NOT written into the store.
    expect(store.presets.find((p) => p.id === 'software-review')).toBeUndefined();
    expect(rt.loadBundledDefaults).toHaveBeenCalled();
  });

  it('keeps unrelated user presets when deleting one', async () => {
    const { rt, store } = makeRuntime([seed('a'), seed('b')]);
    await deletePreset(rt, 'a');
    expect(store.presets.map((p) => p.id)).toEqual(['b']);
  });
});

describe('importPresetsFromString — bounded + validated', () => {
  it('accepts a valid collection and reports the count', async () => {
    const { rt } = makeRuntime();
    const json = JSON.stringify({ presets: [seed('imp1'), seed('imp2')] });
    const out = await importPresetsFromString(rt, json);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
  });

  it('fails closed on invalid JSON and surfaces the error', async () => {
    const { rt, store } = makeRuntime([seed('keep')]);
    const out = await importPresetsFromString(rt, '{nope');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    // Store untouched on rejected import.
    expect(store.presets.map((p) => p.id)).toEqual(['keep']);
  });

  it('fails closed on a structurally invalid preset', async () => {
    const { rt } = makeRuntime();
    const json = JSON.stringify([
      { schemaVersion: PRESET_SCHEMA_VERSION, id: 'x', name: 'X', content: { source: 'bad' } },
    ]);
    const out = await importPresetsFromString(rt, json);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/source/);
  });
});

describe('exportPresetsToString — serialization', () => {
  it('round-trips through the store export helper', () => {
    const { rt } = makeRuntime();
    const json = exportPresetsToString(rt, [seed('a')]);
    expect(json).toContain('"presets"');
    expect(json).toContain('"id":"a"');
  });
});
