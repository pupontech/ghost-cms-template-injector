import { describe, expect, it, vi } from 'vitest';
import type { Preset } from '../../src/preset-schema';
import type {
  ApplicationPlan,
  GhostLiveSurface,
  GhostSnapshot,
  ApplyResult,
  DiscoverOutcome,
} from '../../src/ghost-state';
import { createGhostStateAdapter } from '../../src/ghost-state';
import {
  runApplyPipeline,
  type ApplyPipelineAdapter,
  type ApplyPipelineDeps,
} from '../../src/apply-pipeline';

/** A fake adapter that records calls and applies a plan via an injected surface. */
function fakeAdapter(overrides: Partial<ApplyPipelineAdapter> = {}): {
  adapter: ApplyPipelineAdapter;
  discovers: DiscoverOutcome[];
  snapshots: GhostSnapshot[];
  appliedPlans: ApplicationPlan[];
  nativeSaves: number;
} {
  const discovers: DiscoverOutcome[] = [];
  const snapshots: GhostSnapshot[] = [];
  const appliedPlans: ApplicationPlan[] = [];
  const base: GhostSnapshot = {
    resourceType: 'post',
    resourceId: 'post-1',
    excerpt: null,
    customTemplate: null,
    tags: [],
    lexical: '{"root":{"children":[]}}',
    bodyEmpty: true,
    dirty: false,
    updatedAt: '2026-08-21T00:00:00.000Z',
    saving: false,
  };
  const adapter: ApplyPipelineAdapter = {
    discover() {
      const outcome: DiscoverOutcome = {
        supported: true,
        capability: {
          adapterVersion: 1,
          resourceType: 'post',
          resourceId: 'post-1',
          hasLexical: true,
          canMutateRelations: true,
          canNativeSave: true,
          canRollback: true,
          dirty: false,
          updatedAt: '2026-08-21T00:00:00.000Z',
        },
      };
      discovers.push(outcome);
      return outcome;
    },
    snapshot() {
      const snap = { ...base };
      snapshots.push(snap);
      return snap;
    },
    async apply(plan: ApplicationPlan): Promise<ApplyResult> {
      appliedPlans.push(plan);
      return { resourceId: 'post-1', updatedAt: '2026-08-21T01:00:00.000Z', saved: true };
    },
    ...overrides,
  };
  return { adapter, discovers, snapshots, appliedPlans, nativeSaves: 0 };
}

const presetSoftwareReview: Preset = {
  schemaVersion: 1,
  id: 'software-review',
  name: 'Software Review',
  content: { source: 'inline-html', mode: 'replace', html: '<p>body</p>' },
  metadata: {
    excerpt: { mode: 'only-if-empty', value: 'A hands-on review.' },
    tags: { mode: 'merge', values: ['Reviews'] },
  },
};

function depsWith(opts: {
  adapter?: ApplyPipelineAdapter;
  preset?: Preset | null;
  context?: Record<string, unknown>;
}): ApplyPipelineDeps {
  const { adapter, preset, context } = opts;
  return {
    adapter: adapter ?? fakeAdapter().adapter,
    loadPreset: vi.fn(async () => preset ?? null),
    resolveContext: vi.fn(async () =>
      context ? (context as never) : { snippets: [], templates: ['custom-wide.hbs'] },
    ),
  };
}

describe('Phase-5 atomic apply pipeline', () => {
  it('discovers capability first and fails closed when unsupported', async () => {
    const { adapter } = fakeAdapter({
      discover: () => ({ supported: false, reason: 'native save unreachable' }),
    });
    const deps = depsWith({ adapter, preset: presetSoftwareReview });
    const out = await runApplyPipeline(deps, 'software-review');
    expect(out.status).toBe('unsupported');
    if (out.status !== 'unsupported') throw new Error('wrong');
    expect(out.reason).toMatch(/native save/i);
    // No preset was even loaded once capability is denied.
    expect((deps.loadPreset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('blocks when the preset id is unknown', async () => {
    const deps = depsWith({ preset: null });
    const out = await runApplyPipeline(deps, 'nope');
    expect(out.status).toBe('blocked');
    if (out.status !== 'blocked') throw new Error('wrong');
    expect(out.problems.some((p) => /not found/.test(p))).toBe(true);
  });

  it('blocks when a dependency (template allowlist) is missing', async () => {
    const deps = depsWith({
      preset: {
        ...presetSoftwareReview,
        metadata: {
          ...presetSoftwareReview.metadata,
          customTemplate: { mode: 'replace', value: 'custom-wide.hbs' },
        },
      },
      context: {}, // no templates allowlist → planner refuses
    });
    const out = await runApplyPipeline(deps, 'software-review');
    expect(out.status).toBe('blocked');
  });

  it('applies a ready plan end-to-end (only-if-empty excerpt + merged tags)', async () => {
    const { adapter, appliedPlans } = fakeAdapter();
    const deps = depsWith({ adapter, preset: presetSoftwareReview });
    const out = await runApplyPipeline(deps, 'software-review');
    expect(out.status).toBe('applied');
    expect(appliedPlans.length).toBe(1);
    const actions = appliedPlans[0]!.actions;
    // excerpt only-if-empty with empty live → apply; tags merge → apply.
    expect(actions.find((a) => a.field === 'excerpt')?.status).toBe('apply');
    expect(actions.find((a) => a.field === 'tags')?.status).toBe('apply');
    expect(actions.find((a) => a.field === 'tags')?.value).toEqual(['Reviews']);
  });

  it('holds a live, non-empty excerpt when mode is only-if-empty (skip, no overwrite)', async () => {
    const { adapter, appliedPlans } = fakeAdapter({
      snapshot: () => ({
        resourceType: 'post',
        resourceId: 'post-1',
        excerpt: 'already written by the user',
        customTemplate: null,
        tags: ['Reviews'],
        lexical: '{"root":{"children":[{"children":[{"text":""}]}]}}',
        bodyEmpty: false,
        dirty: true,
        updatedAt: '2026-08-21T00:00:00.000Z',
        saving: false,
      }),
    });
    const deps = depsWith({ adapter, preset: presetSoftwareReview });
    const out = await runApplyPipeline(deps, 'software-review');
    expect(out.status).toBe('applied');
    // excerpt action is skipped (live value wins), tags merge is still applied.
    const excerpt = appliedPlans[0]!.actions.find((a) => a.field === 'excerpt');
    expect(excerpt?.status).toBe('skip');
    expect(appliedPlans[0]!.actions.find((a) => a.field === 'tags')?.status).toBe('apply');
  });

  it('returns needs-prompt and never mutates when a plan awaits confirmation', async () => {
    const { adapter, appliedPlans } = fakeAdapter();
    const promptPreset: Preset = {
      schemaVersion: 1,
      id: 'custom-template-starter',
      name: 'Custom Template Starter',
      content: { source: 'inline-html', mode: 'prompt', html: '<p></p>' },
      metadata: { customTemplate: { mode: 'prompt', value: 'custom-wide.hbs' } },
    };
    const deps = depsWith({ adapter, preset: promptPreset });
    const out = await runApplyPipeline(deps, 'custom-template-starter');
    expect(out.status).toBe('needs-prompt');
    if (out.status !== 'needs-prompt') throw new Error('wrong');
    expect(out.prompts.length).toBeGreaterThan(0);
    expect(appliedPlans.length).toBe(0); // no mutation before prompt answers
  });

  it('applies after prompt answers are supplied', async () => {
    const { adapter, appliedPlans } = fakeAdapter();
    const promptPreset: Preset = {
      schemaVersion: 1,
      id: 'custom-template-starter',
      name: 'Custom Template Starter',
      content: { source: 'inline-html', mode: 'prompt', html: '<p></p>' },
      metadata: { customTemplate: { mode: 'prompt', value: 'custom-wide.hbs' } },
    };
    const deps = depsWith({ adapter, preset: promptPreset });
    const out = await runApplyPipeline(deps, 'custom-template-starter', {
      body: true,
      customTemplate: true,
    });
    expect(out.status).toBe('applied');
    expect(appliedPlans.length).toBe(1);
    expect(appliedPlans[0]!.actions.every((a) => a.status === 'apply' || a.status === 'skip')).toBe(
      true,
    );
  });

  it('surfaces a recoverable apply error instead of throwing', async () => {
    const { adapter } = fakeAdapter({
      apply: () => {
        throw new Error('SAVE_FAILED');
      },
    });
    const deps = depsWith({ adapter, preset: presetSoftwareReview });
    const out = await runApplyPipeline(deps, 'software-review');
    expect(out.status).toBe('error');
    if (out.status !== 'error') throw new Error('wrong');
    expect(out.error).toMatch(/SAVE_FAILED/);
  });

  it('double-apply is serialized by the adapter (second call cannot mutate while first runs)', async () => {
    // The real bridge/ghost-state serialize transactional ops (BUSY / #busy).
    // Here we model a serializeOnce surface that refuses re-entry.
    let inFlight = false;
    const surface = makeSurface();
    const ghostState = makeGhostState(surface);
    const adapter: ApplyPipelineAdapter = {
      discover: () => ghostState.discover(),
      snapshot: () => ghostState.snapshot(),
      async apply(plan: ApplicationPlan): Promise<ApplyResult> {
        if (inFlight) throw new Error('BUSY');
        inFlight = true;
        try {
          return await ghostState.apply(plan);
        } finally {
          inFlight = false;
        }
      },
    };
    const deps = depsWith({ adapter, preset: presetSoftwareReview });
    const [a, b] = await Promise.all([
      runApplyPipeline(deps, 'software-review'),
      runApplyPipeline(deps, 'software-review'),
    ]);
    const applied = [a, b].filter((r) => r.status === 'applied').length;
    expect(applied).toBe(1);
  });
});

/* ---- tiny surface/state fakes mirroring ghost-state's contract ---- */
function makeSurface(overrides: Partial<GhostLiveSurface> = {}): GhostLiveSurface {
  return {
    getResourceType: () => 'post',
    getResourceId: () => 'post-1',
    isDirty: () => false,
    getUpdatedAt: () => '2026-08-21T00:00:00.000Z',
    getLexical: () => '{"root":{"children":[]}}',
    isBodyEmpty: () => true,
    getExcerpt: () => null,
    getCustomTemplate: () => null,
    getTags: () => [],
    setField: vi.fn(),
    setLexical: vi.fn(),
    nativeSave: vi.fn(async () => ({ updatedAt: '2026-08-21T01:00:00.000Z' })),
    captureRollback: vi.fn(() => ({ token: 'snap' })),
    restoreRollback: vi.fn(),
    ...overrides,
  };
}

function makeGhostState(surface: GhostLiveSurface) {
  return createGhostStateAdapter(surface);
}
