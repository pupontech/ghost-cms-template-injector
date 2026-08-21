import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_BYTES, PRESET_SCHEMA_VERSION, type Preset } from '../../src/preset-schema';
import {
  STORAGE_KEY,
  exportPresets,
  importPresets,
  importPresetsIntoStore,
  listPresets,
  loadBundledDefaults,
  savePreset,
} from '../../src/preset-store';
import { bundledSeedPresets } from '../helpers/bundled-seeds';

type StorageArea = Record<string, unknown>;

interface StoreDoc {
  schemaVersion: number;
  version: number;
  presets: Preset[];
}

function fakeStorageArea(initial: StorageArea = {}) {
  const area: StorageArea = { ...initial };
  const api = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return { ...area };
      if (typeof keys === 'string') return keys in area ? { [keys]: area[keys] } : {};
      const out: StorageArea = {};
      for (const k of keys) if (k in area) out[k] = area[k];
      return out;
    }),
    set: vi.fn(async (items: StorageArea) => {
      Object.assign(area, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete area[k];
    }),
  };
  return { area, api };
}

let storage: ReturnType<typeof fakeStorageArea>;

function chromeStub(initial: StorageArea = {}): void {
  storage = fakeStorageArea(initial);
  (globalThis as { chrome?: unknown }).chrome = { storage: { local: storage.api } };
}

function storedDoc(
  doc: Partial<Omit<StoreDoc, 'presets'>> & { presets?: Preset[] } = {},
): StorageArea {
  return {
    [STORAGE_KEY]: { schemaVersion: PRESET_SCHEMA_VERSION, version: 0, ...doc },
  };
}

function seedPreset(): Preset {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id: 'test-preset',
    name: 'Test Preset',
    content: { source: 'inline-html', mode: 'replace', html: '<p>hi</p>' },
  };
}

describe('loadBundledDefaults — read-only packaged seeds', () => {
  beforeEach(() => chromeStub());

  it('loads and validates presets/presets.json as defaults without touching storage', async () => {
    const defaults = await loadBundledDefaults();
    expect(defaults.map((p) => p.id)).toEqual(bundledSeedPresets().map((p) => p.id));
    expect(storage.api.set).not.toHaveBeenCalled();
  });

  it('never persists bundled defaults into chrome.storage.local', async () => {
    await loadBundledDefaults();
    await listPresets();
    expect(Object.keys(storage.area)).toEqual([]);
  });
});

describe('listPresets — defaults + local overrides', () => {
  beforeEach(() => chromeStub());

  it('returns bundled defaults when storage is empty', async () => {
    const presets = await listPresets();
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every((p) => p.schemaVersion === PRESET_SCHEMA_VERSION)).toBe(true);
  });

  it('an override with a default id shadows the bundled preset at the same position', async () => {
    chromeStub(
      storedDoc({
        version: 1,
        presets: [{ ...bundledSeedPresets()[0]!, name: 'Renamed Override' }],
      }),
    );
    const presets = await listPresets();
    expect(presets[0]?.name).toBe('Renamed Override');
    expect(presets).toHaveLength(bundledSeedPresets().length);
  });

  it('user-only presets appear after the bundled defaults', async () => {
    chromeStub(storedDoc({ version: 1, presets: [seedPreset()] }));
    const presets = await listPresets();
    expect(presets.at(-1)?.id).toBe('test-preset');
    expect(presets).toHaveLength(bundledSeedPresets().length + 1);
  });

  it('fails closed to bundled defaults when stored overrides are corrupt or invalid', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chromeStub(storedDoc({ schemaVersion: 999, presets: [] }));
    await expect(listPresets()).resolves.toEqual(bundledSeedPresets());

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('savePreset — validated atomic persistence', () => {
  beforeEach(() => chromeStub());

  it('rejects an invalid preset and writes nothing', async () => {
    chromeStub(storedDoc());
    const before = { ...storage.area };
    await expect(
      savePreset({
        schemaVersion: PRESET_SCHEMA_VERSION,
        id: 'bad',
        name: 'Bad',
        content: { source: 'inline-html', mode: 'append' as never, html: '<p>x</p>' },
      }),
    ).rejects.toThrow(/append/);
    expect(storage.area).toEqual(before);
    expect(storage.api.set).not.toHaveBeenCalled();
  });

  it('upserts by id: insert new, replace existing, bump store version atomically', async () => {
    await savePreset(seedPreset());
    let doc = storage.area[STORAGE_KEY] as StoreDoc;
    expect(doc.version).toBe(1);
    expect(doc.presets.map((p) => p.id)).toEqual(['test-preset']);

    await savePreset({ ...seedPreset(), name: 'Updated' });
    doc = storage.area[STORAGE_KEY] as StoreDoc;
    expect(doc.version).toBe(2);
    expect(doc.presets).toHaveLength(1);
    expect(doc.presets[0]?.name).toBe('Updated');
    // one atomic set call per save, writing only the store key
    expect(storage.api.set).toHaveBeenCalledTimes(2);
    for (const call of storage.api.set.mock.calls) {
      expect(Object.keys(call[0] as StorageArea)).toEqual([STORAGE_KEY]);
    }
  });
});

describe('schema-version migrations', () => {
  beforeEach(() => chromeStub());

  it('migrates a legacy document missing `version` by normalizing on read; bumps on next save', async () => {
    chromeStub({
      [STORAGE_KEY]: { schemaVersion: PRESET_SCHEMA_VERSION, presets: [seedPreset()] },
    });
    await expect(listPresets()).resolves.toEqual([...bundledSeedPresets(), seedPreset()]);
    // migration is lazy: nothing written until a mutation
    await savePreset({ ...seedPreset(), id: 'second', name: 'Second' });
    const doc = storage.area[STORAGE_KEY] as StoreDoc;
    expect(doc.version).toBe(1);
    expect(doc.presets.map((p) => p.id)).toEqual(['test-preset', 'second']);
  });

  it('refuses a future schemaVersion it cannot understand (fail closed)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chromeStub({
      [STORAGE_KEY]: { schemaVersion: PRESET_SCHEMA_VERSION + 1, presets: [seedPreset()] },
    });
    await expect(listPresets()).resolves.toEqual(bundledSeedPresets());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('importPresets / exportPresets — bounded, validated round-trip', () => {
  beforeEach(() => chromeStub());

  it('round-trips exported JSON through import validation', () => {
    const json = exportPresets(bundledSeedPresets());
    expect(importPresets(json)).toEqual(bundledSeedPresets());
  });

  it('rejects oversized imports before parsing', () => {
    const big = JSON.stringify({ schemaVersion: PRESET_SCHEMA_VERSION, presets: [] }).padEnd(
      MAX_IMPORT_BYTES + 1,
      ' ',
    );
    expect(() => importPresets(big)).toThrow(RangeError);
  });

  it('rejects malformed JSON and invalid presets fail-closed', () => {
    expect(() => importPresets('{nope')).toThrow(SyntaxError);
    expect(() =>
      importPresets(JSON.stringify([{ ...seedPreset(), content: { source: 'nope' } }])),
    ).toThrow(TypeError);
  });

  it('persists an imported collection as one atomic replacement', async () => {
    await importPresetsIntoStore(exportPresets(bundledSeedPresets()));
    const doc = storage.area[STORAGE_KEY] as StoreDoc;
    expect(doc.presets).toEqual(bundledSeedPresets());
    expect(doc.version).toBe(1);
    expect(storage.api.set).toHaveBeenCalledTimes(1);
  });
});
