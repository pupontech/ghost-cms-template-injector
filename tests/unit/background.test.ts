import { describe, expect, it, vi } from 'vitest';
import { createBackground } from '../../src/background';

describe('background service worker scaffold', () => {
  it('installs exactly one runtime.onInstalled listener', () => {
    const addListener = vi.fn();
    const bg = createBackground({ addOnInstalledListener: addListener });
    bg.init();
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('init is idempotent', () => {
    let count = 0;
    const bg = createBackground({
      addOnInstalledListener: () => {
        count += 1;
      },
    });
    bg.init();
    bg.init();
    expect(count).toBe(1);
  });

  it('onInstalled performs no storage or network side effects (scaffold only)', async () => {
    const storageSet = vi.fn();
    const fetchFn = vi.fn();
    const bg = createBackground({
      addOnInstalledListener: () => {},
      storage: { set: storageSet } as never,
      fetchFn,
    });
    await bg.handleInstalled({ reason: 'install' });
    expect(storageSet).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
