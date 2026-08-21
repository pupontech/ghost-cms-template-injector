/**
 * Test helper: install an in-memory `chrome.storage.local` stub on
 * `globalThis` so `preset-store` can run in Node. Mirrors the contract used by
 * the production MV3 extension (single-key atomic set/get).
 */
export interface FakeStorageArea {
  area: Record<string, unknown>;
  api: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
}

export function fakeStorageArea(initial: Record<string, unknown> = {}): FakeStorageArea {
  const area: Record<string, unknown> = { ...initial };
  return {
    area,
    api: {
      get: async (key: string) => (key in area ? { [key]: area[key] } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) area[k] = v;
      },
    },
  };
}

export function installChromeStorageStub(initial: Record<string, unknown> = {}): FakeStorageArea {
  const storage = fakeStorageArea(initial);
  (globalThis as { chrome?: unknown }).chrome = { storage: { local: storage.api } };
  return storage;
}
