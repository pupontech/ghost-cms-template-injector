import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SCRIPT_REGISTRATION_ID,
  MAIN_WORLD_REGISTRATION_ID,
  createHostPermission,
  ghostMatchForOrigin,
  normalizeExactOrigin,
  type HostPermissionDeps,
} from '../../src/host-permission';

function makeDeps(overrides: Partial<HostPermissionDeps> = {}): {
  deps: HostPermissionDeps;
  calls: {
    requestPermission: ReturnType<typeof vi.fn>;
    registerContentScripts: ReturnType<typeof vi.fn>;
    unregisterContentScripts: ReturnType<typeof vi.fn>;
    removePermission: ReturnType<typeof vi.fn>;
    storageSet: ReturnType<typeof vi.fn>;
    storageGet: ReturnType<typeof vi.fn>;
  };
} {
  const requestPermission = vi.fn().mockResolvedValue(true);
  const getAllPermissions = vi.fn().mockResolvedValue({ origins: [] });
  const registerContentScripts = vi.fn().mockResolvedValue(undefined);
  const unregisterContentScripts = vi.fn().mockResolvedValue(undefined);
  const removePermission = vi.fn().mockResolvedValue(true);
  const storageGet = vi.fn().mockResolvedValue(undefined);
  const storageSet = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      requestPermission,
      getAllPermissions,
      registerContentScripts,
      unregisterContentScripts,
      removePermission,
      storageGet,
      storageSet,
      ...overrides,
    },
    calls: {
      requestPermission,
      registerContentScripts,
      unregisterContentScripts,
      removePermission,
      storageSet,
      storageGet,
    },
  };
}

describe('normalizeExactOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(normalizeExactOrigin('https://ghost.example.com')?.origin).toBe(
      'https://ghost.example.com',
    );
  });

  it('accepts a trailing-slash origin', () => {
    expect(normalizeExactOrigin('https://ghost.example.com/')?.origin).toBe(
      'https://ghost.example.com',
    );
  });

  it('rejects http origins', () => {
    expect(normalizeExactOrigin('http://ghost.example.com')).toBeNull();
  });

  it('rejects wildcard / all_urls inputs', () => {
    expect(normalizeExactOrigin('https://*/ghost/*')).toBeNull();
    expect(normalizeExactOrigin('<all_urls>')).toBeNull();
  });

  it('rejects origins with a non-Ghost path or query', () => {
    expect(normalizeExactOrigin('https://ghost.example.com/blog')).toBeNull();
    expect(normalizeExactOrigin('https://ghost.example.com?x=1')).toBeNull();
  });
});

describe('ghostMatchForOrigin', () => {
  it('builds the scoped /ghost/* pattern', () => {
    expect(ghostMatchForOrigin('https://ghost.example.com')).toBe(
      'https://ghost.example.com/ghost/*',
    );
  });
});

describe('createHostPermission — consent flow', () => {
  it('rejects an invalid origin before requesting permission', async () => {
    const { deps, calls } = makeDeps();
    const hp = createHostPermission(deps);
    const result = await hp.grant('https://*/ghost/*');
    expect(result).toEqual({
      ok: false,
      enabled: false,
      origin: null,
      error: 'Invalid Ghost origin.',
    });
    expect(calls.requestPermission).not.toHaveBeenCalled();
  });

  it('requests only the exact origin /ghost/* and registers dynamic scripts after consent', async () => {
    const { deps, calls } = makeDeps();
    const hp = createHostPermission(deps);
    const result = await hp.grant('https://ghost.example.com');

    expect(calls.requestPermission).toHaveBeenCalledTimes(1);
    expect(calls.requestPermission).toHaveBeenCalledWith(['https://ghost.example.com/ghost/*']);
    expect(calls.registerContentScripts).toHaveBeenCalledTimes(1);
    const registered = calls.registerContentScripts.mock.calls[0]?.[0] as Array<{
      id: string;
      matches: string[];
      js: string[];
    }>;
    expect(registered[0]?.id).toBe(CONTENT_SCRIPT_REGISTRATION_ID);
    expect(registered[0]?.matches).toEqual(['https://ghost.example.com/ghost/*']);
    expect(registered[0]?.js).toEqual(['dist/content-script.js', 'dist/toolbar.js']);
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.origin).toBe('https://ghost.example.com');
  });

  it('treats granting the already-enabled installation as an idempotent success', async () => {
    const { deps, calls } = makeDeps({
      getAllPermissions: vi.fn().mockResolvedValue({
        origins: ['https://ghost.example.com/ghost/*'],
      }),
    });
    calls.storageGet.mockResolvedValue({
      origin: 'https://ghost.example.com',
      match: 'https://ghost.example.com/ghost/*',
      grantedAt: 1,
    });

    const result = await createHostPermission(deps).grant('https://ghost.example.com');

    expect(result).toEqual({ ok: true, enabled: true, origin: 'https://ghost.example.com' });
    expect(calls.requestPermission).not.toHaveBeenCalled();
    expect(calls.registerContentScripts).not.toHaveBeenCalled();
  });

  it('does not register when the user denies consent (M3)', async () => {
    const { deps, calls } = makeDeps({
      requestPermission: vi.fn().mockResolvedValue(false),
    });
    const hp = createHostPermission(deps);
    const result = await hp.grant('https://ghost.example.com');
    expect(result.ok).toBe(false);
    expect(result.enabled).toBe(false);
    expect(calls.registerContentScripts).not.toHaveBeenCalled();
  });

  it('rolls back a newly granted permission when script registration fails', async () => {
    const { deps, calls } = makeDeps({
      registerContentScripts: vi.fn().mockRejectedValue(new Error('registration failed')),
    });

    const result = await createHostPermission(deps).grant('https://ghost.example.com');

    expect(result).toMatchObject({ ok: false, enabled: false });
    expect(calls.removePermission).toHaveBeenCalledWith(['https://ghost.example.com/ghost/*']);
    expect(calls.storageSet).not.toHaveBeenCalled();
  });

  it('reports status enabled only when consent matches a granted origin', async () => {
    const { deps, calls } = makeDeps({
      getAllPermissions: vi.fn().mockResolvedValue({
        origins: ['https://ghost.example.com/ghost/*'],
      }),
    });
    calls.storageGet.mockResolvedValue({
      origin: 'https://ghost.example.com',
      match: 'https://ghost.example.com/ghost/*',
      grantedAt: 1,
    });
    const hp = createHostPermission(deps);
    const status = await hp.status();
    expect(status).toEqual({ enabled: true, origin: 'https://ghost.example.com' });
  });

  it('reports status disabled when no consent stored', async () => {
    const { deps } = makeDeps();
    const hp = createHostPermission(deps);
    const status = await hp.status();
    expect(status).toEqual({ enabled: false, origin: null });
  });

  it('revoke unregisters scripts and drops consent', async () => {
    const { deps, calls } = makeDeps();
    const hp = createHostPermission(deps);
    const status = await hp.revoke();
    // Both the isolated id and the MAIN-world id are unregistered (see the
    // dedicated C8 test below for the full assertion).
    expect(calls.unregisterContentScripts).toHaveBeenCalledWith([
      CONTENT_SCRIPT_REGISTRATION_ID,
      MAIN_WORLD_REGISTRATION_ID,
    ]);
    expect(status).toEqual({ enabled: false, origin: null });
  });

  it('revoke removes the exact optional host permission recorded in consent', async () => {
    const { deps, calls } = makeDeps({
      getAllPermissions: vi.fn().mockResolvedValue({
        origins: ['https://ghost.example.com/ghost/*'],
      }),
    });
    calls.storageGet.mockResolvedValue({
      origin: 'https://ghost.example.com',
      match: 'https://ghost.example.com/ghost/*',
      grantedAt: 1,
    });

    await createHostPermission(deps).revoke();

    expect(calls.removePermission).toHaveBeenCalledWith(['https://ghost.example.com/ghost/*']);
  });

  it('revoke unregisters BOTH the isolated and MAIN-world scripts (C8)', async () => {
    const { deps, calls } = makeDeps();
    const hp = createHostPermission(deps);
    const status = await hp.revoke();
    // grant() registers two scripts keyed by the isolated id and the MAIN-world
    // id (`...-main`). revoke() must remove both so the MAIN bridge does not
    // linger after the user disables the toolbar (release defect C8).
    expect(calls.unregisterContentScripts).toHaveBeenCalledWith([
      CONTENT_SCRIPT_REGISTRATION_ID,
      MAIN_WORLD_REGISTRATION_ID,
    ]);
    // The MAIN-world id is the isolated id with the `-main` suffix.
    expect(MAIN_WORLD_REGISTRATION_ID).toBe(`${CONTENT_SCRIPT_REGISTRATION_ID}-main`);
    expect(status).toEqual({ enabled: false, origin: null });
  });
});
