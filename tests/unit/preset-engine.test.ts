/**
 * Phase-2 field-mode planning engine — behavior tests.
 *
 * The planner is pure: it takes a validated Preset, a live editor snapshot,
 * and a dependency context, and returns an immutable per-field plan. It
 * performs no storage, API, bridge, or UI work (C4/C5/C6).
 */
import { describe, expect, it } from 'vitest';

import {
  createEditorSnapshot,
  createPlanContext,
  planPresetApplication,
  resolvePrompts,
} from '../../src/preset-engine';
import { validatePreset } from '../../src/preset-schema';

const basePreset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: 'test-preset',
  name: 'Test Preset',
  content: { source: 'inline-html', mode: 'replace', html: '<p>Hello</p>' },
  ...overrides,
});

describe('planPresetApplication — input immutability', () => {
  it('does not mutate the preset, snapshot, or context', () => {
    const raw = basePreset({
      metadata: { tags: { mode: 'merge', values: [' Alpha ', 'Beta'] } },
    });
    const preset = validatePreset(raw);
    const presetCopy = structuredClone(preset);
    const snapshot = createEditorSnapshot({ tags: ['Existing'] });
    const snapshotCopy = structuredClone(snapshot);
    const context = createPlanContext({ snippets: ['S'], templates: ['a.hbs'] });
    const contextCopy = structuredClone(context);

    planPresetApplication(preset, snapshot, context);

    expect(preset).toEqual(presetCopy);
    expect(snapshot).toEqual(snapshotCopy);
    expect(context).toEqual(contextCopy);
  });

  it('returns a deeply frozen plan', () => {
    const plan = planPresetApplication(
      validatePreset(basePreset()),
      createEditorSnapshot(),
      createPlanContext(),
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    for (const action of plan.actions) expect(Object.isFrozen(action)).toBe(true);
  });
});

describe('C4 — dependency validation aborts before any field is planned', () => {
  it('blocks when the referenced snippet is missing', () => {
    const preset = validatePreset({
      ...basePreset(),
      content: { source: 'ghost-snippet', mode: 'replace', snippet: 'Missing Snippet' },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot(),
      createPlanContext({ snippets: ['Other'] }),
    );
    expect(plan.status).toBe('blocked');
    expect(plan.problems).toContain('content.source: snippet "Missing Snippet" not found');
    expect(plan.actions).toHaveLength(0);
  });

  it('blocks when the custom template is not an active-theme filename', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { customTemplate: { mode: 'replace', value: 'nope.hbs' } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ customTemplate: null }),
      createPlanContext({ templates: ['real.hbs'] }),
    );
    expect(plan.status).toBe('blocked');
    expect(plan.problems.join('\n')).toContain('customTemplate');
    expect(plan.actions).toHaveLength(0);
  });

  it('fails closed when the template allowlist is unknown', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { customTemplate: { mode: 'replace', value: 'maybe.hbs' } },
    });
    const plan = planPresetApplication(preset, createEditorSnapshot(), createPlanContext());
    expect(plan.status).toBe('blocked');
    expect(plan.problems.join('\n')).toContain('template allowlist unavailable');
    expect(plan.actions).toHaveLength(0);
  });
});

describe('body modes (C5 — replace | only-if-empty | prompt only)', () => {
  it('plans a set for replace mode regardless of current state', () => {
    const plan = planPresetApplication(
      validatePreset(basePreset()),
      createEditorSnapshot({ bodyEmpty: false }),
      createPlanContext(),
    );
    const body = plan.actions.find((a) => a.field === 'body');
    expect(body).toMatchObject({ op: 'set', status: 'apply' });
  });

  it('skips only-if-empty when the live body is not empty', () => {
    const preset = validatePreset({
      ...basePreset(),
      content: { source: 'inline-html', mode: 'only-if-empty', html: '<p>x</p>' },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ bodyEmpty: false }),
      createPlanContext(),
    );
    expect(plan.actions.find((a) => a.field === 'body')).toMatchObject({ op: 'skip' });
  });

  it('applies only-if-empty when the live body is empty', () => {
    const preset = validatePreset({
      ...basePreset(),
      content: { source: 'inline-html', mode: 'only-if-empty', html: '<p>x</p>' },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ bodyEmpty: true }),
      createPlanContext(),
    );
    expect(plan.actions.find((a) => a.field === 'body')).toMatchObject({ op: 'set' });
  });

  it('marks prompt mode as needing a user answer, not a silent write', () => {
    const preset = validatePreset({
      ...basePreset(),
      content: { source: 'inline-html', mode: 'prompt', html: '<p>x</p>' },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ bodyEmpty: false }),
      createPlanContext(),
    );
    const body = plan.actions.find((a) => a.field === 'body');
    expect(body?.status).toBe('prompt');
    expect(plan.status).toBe('needs-prompt');
    expect(plan.actions.find((a) => a.field === 'body')?.op).not.toBe('set-implicit');
  });
});

describe('metadata modes', () => {
  it('replaces excerpt and respects only-if-empty against the live value', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { excerpt: { mode: 'only-if-empty', value: 'New excerpt' } },
    });
    const filled = planPresetApplication(
      preset,
      createEditorSnapshot({ excerpt: 'Already here' }),
      createPlanContext(),
    );
    expect(filled.actions.find((a) => a.field === 'excerpt')?.op).toBe('skip');

    const empty = planPresetApplication(
      preset,
      createEditorSnapshot({ excerpt: null }),
      createPlanContext(),
    );
    expect(empty.actions.find((a) => a.field === 'excerpt')).toMatchObject({
      op: 'set',
      value: 'New excerpt',
    });
  });

  it('prompts for excerpt when mode is prompt', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { excerpt: { mode: 'prompt', value: 'Ask me' } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ excerpt: 'Existing' }),
      createPlanContext(),
    );
    expect(plan.status).toBe('needs-prompt');
    expect(plan.actions.find((a) => a.field === 'excerpt')?.status).toBe('prompt');
  });

  it('sets custom template via full .hbs filename', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { customTemplate: { mode: 'replace', value: 'custom.hbs' } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ customTemplate: null }),
      createPlanContext({ templates: ['custom.hbs'] }),
    );
    expect(plan.actions.find((a) => a.field === 'customTemplate')).toMatchObject({
      op: 'set',
      value: 'custom.hbs',
    });
  });
});

describe('tags — normalization, order-preserving merge, replacement', () => {
  it('replace normalizes values (trim, dedupe, drop empties) and sets the full list', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { tags: { mode: 'replace', values: ['  Alpha ', 'Beta', 'Alpha'] } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ tags: ['Old'] }),
      createPlanContext(),
    );
    expect(plan.actions.find((a) => a.field === 'tags')).toMatchObject({
      op: 'set',
      value: ['Alpha', 'Beta'],
    });
  });

  it('merge preserves existing display order and appends only non-duplicates', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { tags: { mode: 'merge', values: ['Zeta', 'alpha', ' Beta '] } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ tags: ['Alpha', 'Mid'] }),
      createPlanContext(),
    );
    expect(plan.actions.find((a) => a.field === 'tags')).toMatchObject({
      op: 'set',
      value: ['Alpha', 'Mid', 'Zeta', 'Beta'],
    });
  });

  it('tags only-if-empty skips when live tags exist and applies when none', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { tags: { mode: 'only-if-empty', values: ['Solo'] } },
    });
    const hasTags = planPresetApplication(
      preset,
      createEditorSnapshot({ tags: ['Existing'] }),
      createPlanContext(),
    );
    expect(hasTags.actions.find((a) => a.field === 'tags')?.op).toBe('skip');

    const noTags = planPresetApplication(
      preset,
      createEditorSnapshot({ tags: [] }),
      createPlanContext(),
    );
    expect(noTags.actions.find((a) => a.field === 'tags')).toMatchObject({
      op: 'set',
      value: ['Solo'],
    });
  });

  it('never emits append/merge as an apply-time op — merged result is one full-list set', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { tags: { mode: 'merge', values: ['New'] } },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ tags: ['A'] }),
      createPlanContext(),
    );
    const tags = plan.actions.find((a) => a.field === 'tags');
    expect(tags?.op).toBe('set');
  });
});

describe('plan completeness and status aggregation (C4)', () => {
  it('emits exactly one action per requested field, in schema order: body, excerpt, customTemplate, tags', () => {
    const preset = validatePreset({
      ...basePreset(),
      content: { source: 'inline-html', mode: 'replace', html: '<p>b</p>' },
      metadata: {
        excerpt: { mode: 'replace', value: 'e' },
        customTemplate: { mode: 'replace', value: 't.hbs' },
        tags: { mode: 'replace', values: ['x'] },
      },
    });
    const plan = planPresetApplication(
      preset,
      createEditorSnapshot({ customTemplate: null }),
      createPlanContext({ templates: ['t.hbs'] }),
    );
    expect(plan.actions.map((a) => a.field)).toEqual(['body', 'excerpt', 'customTemplate', 'tags']);
    expect(plan.status).toBe('ready');
  });

  it('reports ready only when every action is applicable without prompting', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: {
        excerpt: { mode: 'prompt', value: 'p' },
        tags: { mode: 'replace', values: ['t'] },
      },
    });
    const plan = planPresetApplication(preset, createEditorSnapshot(), createPlanContext());
    expect(plan.status).toBe('needs-prompt');
  });
});

describe('resolvePrompts — turning needs-prompt into an executable plan', () => {
  it('applies accepted prompt answers and keeps declined ones skipped', () => {
    const preset = validatePreset({
      ...basePreset(),
      metadata: { excerpt: { mode: 'prompt', value: 'Chosen' } },
    });
    const pending = planPresetApplication(
      preset,
      createEditorSnapshot({ excerpt: 'Live excerpt' }),
      createPlanContext(),
    );
    expect(pending.status).toBe('needs-prompt');

    const resolved = resolvePrompts(pending, { excerpt: true });
    expect(resolved.status).toBe('ready');
    expect(resolved.actions.find((a) => a.field === 'excerpt')).toMatchObject({
      op: 'set',
      value: 'Chosen',
    });

    const declined = resolvePrompts(pending, { excerpt: false });
    expect(declined.status).toBe('ready');
    expect(declined.actions.find((a) => a.field === 'excerpt')?.op).toBe('skip');
  });

  it('rejects answers for plans that are not awaiting prompts', () => {
    const ready = planPresetApplication(
      validatePreset(basePreset()),
      createEditorSnapshot(),
      createPlanContext(),
    );
    expect(() => resolvePrompts(ready, { body: true })).toThrow();
  });
});
