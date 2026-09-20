import { describe, expect, it, vi } from 'vitest';

import {
  asCaptureOutcome,
  asCapturedSource,
  captureCurrent,
  capturePost,
  listCapturable,
  saveCapturedPreset,
  type CaptureOutcome,
} from '../../src/preset-import';
import { validatePreset } from '../../src/preset-schema';

const BODY =
  '{"root":{"children":[{"children":[{"text":"Hello","type":"extended-text","version":1}],"type":"paragraph","version":1}],"type":"root","version":1}}';

const SOURCE = {
  resourceType: 'post' as const,
  title: 'Imported post',
  excerpt: 'Summary text',
  tags: ['Alpha', 'Beta'],
  customTemplate: null,
  featureImage: 'https://example.com/content/images/hero.png',
  lexical: BODY,
};

const OUTCOME: CaptureOutcome = {
  source: SOURCE,
  warnings: [],
  readFrom: 'admin-api',
  siteOrigin: 'https://example.com',
};

function reply(result: unknown) {
  return { source: 'x', ok: true, result };
}

describe('preset-import payload validation', () => {
  it('accepts a well-formed capture source and normalizes odd fields', () => {
    expect(asCapturedSource(SOURCE)).toEqual(SOURCE);
    expect(
      asCapturedSource({ ...SOURCE, title: 7, tags: ['ok'], siteOrigin: 'ignored' }),
    ).toMatchObject({ title: null, tags: ['ok'] });
  });

  it('rejects unusable sources instead of coercing them', () => {
    expect(asCapturedSource(null)).toBeNull();
    expect(asCapturedSource({ ...SOURCE, resourceType: 'snippet' })).toBeNull();
    expect(asCapturedSource({ ...SOURCE, tags: 'Alpha' })).toBeNull();
    expect(asCapturedSource({ ...SOURCE, tags: [1, 2] })).toBeNull();
  });

  it('reads an outcome envelope, defaulting warnings and read source', () => {
    const parsed = asCaptureOutcome({ source: SOURCE, siteOrigin: 'https://example.com' });
    expect(parsed).toEqual({
      source: SOURCE,
      warnings: [],
      readFrom: 'live-editor',
      siteOrigin: 'https://example.com',
    });
    expect(
      asCaptureOutcome({ source: SOURCE, warnings: ['a', 3], readFrom: 'admin-api' }),
    ).toMatchObject({ warnings: ['a'], readFrom: 'admin-api' });
    expect(asCaptureOutcome({ nope: true })).toBeNull();
  });
});

describe('preset-import transport helpers', () => {
  it('lists posts and pages through the sender, dropping malformed rows', async () => {
    const send = vi.fn().mockResolvedValue(
      reply({
        entries: [
          {
            id: 'p1',
            title: 'First',
            status: 'published',
            updatedAt: '2026-09-01T00:00:00.000Z',
            resourceType: 'post',
          },
          { id: 'x1', title: 'Page', resourceType: 'page' },
          { id: 'bad', title: 'No type' },
        ],
      }),
    );
    const listed = await listCapturable(send);
    expect(send).toHaveBeenCalledWith({ op: 'listPosts' });
    expect(listed.ok).toBe(true);
    expect(listed.entries).toEqual([
      {
        id: 'p1',
        title: 'First',
        status: 'published',
        updatedAt: '2026-09-01T00:00:00.000Z',
        resourceType: 'post',
      },
      { id: 'x1', title: 'Page', status: 'unknown', updatedAt: null, resourceType: 'page' },
    ]);
  });

  it('surfaces a failed list without pretending it is empty-but-fine', async () => {
    const listed = await listCapturable(
      vi.fn().mockResolvedValue({ source: 'x', ok: false, error: 'NO_GHOST_TAB' }),
    );
    expect(listed).toEqual({ ok: false, entries: [], error: 'NO_GHOST_TAB' });
  });

  it('captures the open editor and validates the payload', async () => {
    const ok = await captureCurrent(vi.fn().mockResolvedValue(reply(OUTCOME)));
    expect(ok.ok).toBe(true);
    expect(ok.outcome?.source.tags).toEqual(['Alpha', 'Beta']);

    const junk = await captureCurrent(vi.fn().mockResolvedValue(reply({ source: { title: 1 } })));
    expect(junk).toEqual({
      ok: false,
      error: 'the Ghost tab returned an unusable capture payload',
    });
  });

  it('refuses an invalid or missing capturePost target before sending anything', async () => {
    const send = vi.fn();
    await expect(capturePost(send, 'post', '   ')).resolves.toMatchObject({
      ok: false,
      error: 'a post must be selected first',
    });
    await expect(capturePost(send, 'snippet' as never, 'x')).resolves.toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();

    const sent = vi.fn().mockResolvedValue(reply(OUTCOME));
    await capturePost(sent, 'page', 'x1');
    expect(sent).toHaveBeenCalledWith({
      op: 'capturePost',
      resourceType: 'page',
      resourceId: 'x1',
    });
  });

  it('reports a transport throw as an error result', async () => {
    const send = vi.fn().mockRejectedValue(new Error('no receiver'));
    await expect(captureCurrent(send)).resolves.toEqual({ ok: false, error: 'no receiver' });
    await expect(listCapturable(send)).resolves.toMatchObject({ ok: false, error: 'no receiver' });
  });
});

describe('saveCapturedPreset', () => {
  it('builds a validated preset and stores it under a free id', async () => {
    const savePreset = vi.fn().mockImplementation(async (input: unknown) => input);
    const result = await saveCapturedPreset(
      OUTCOME,
      { name: 'Imported post' },
      {
        loadPresets: vi.fn().mockResolvedValue([{ id: 'imported-post' }]),
        savePreset,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.preset?.id).toBe('imported-post-2');
    expect(validatePreset(result.preset)).toEqual(result.preset);
    expect(result.preset?.metadata?.featureImage).toEqual({
      mode: 'only-if-empty',
      url: '/content/images/hero.png',
    });
  });

  it('refuses to store something the builder rejected', async () => {
    const savePreset = vi.fn();
    const result = await saveCapturedPreset(
      { ...OUTCOME, source: { ...SOURCE, lexical: null } },
      { name: 'Broken' },
      { loadPresets: vi.fn().mockResolvedValue([]), savePreset },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no readable body/);
    expect(savePreset).not.toHaveBeenCalled();
  });

  it('reports a store rejection without claiming success', async () => {
    const result = await saveCapturedPreset(
      OUTCOME,
      { name: 'Any' },
      {
        loadPresets: vi.fn().mockResolvedValue([]),
        savePreset: vi.fn().mockRejectedValue(new Error('storage full')),
      },
    );
    expect(result).toEqual({ ok: false, warnings: [], error: 'storage full' });
  });

  it('keeps warnings from both the capture and the build', async () => {
    const long = 'x'.repeat(400);
    const result = await saveCapturedPreset(
      {
        ...OUTCOME,
        warnings: ['editor had unsaved changes'],
        source: { ...SOURCE, excerpt: long },
      },
      { name: 'Warned' },
      {
        loadPresets: vi.fn().mockResolvedValue([]),
        savePreset: vi.fn().mockImplementation(async (input: unknown) => input),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/unsaved changes/);
    expect(result.warnings.join(' ')).toMatch(/trimmed to 300 characters/);
  });
});
