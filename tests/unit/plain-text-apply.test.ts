import { describe, expect, it } from 'vitest';
import { planPresetApplication, createEditorSnapshot } from '../../src/preset-engine';
import { validatePreset } from '../../src/preset-schema';

describe('plain text body application', () => {
  it('resolves owner-authored text to valid Lexical for one body action', () => {
    const preset = validatePreset({
      schemaVersion: 1,
      id: 'plain',
      name: 'Plain',
      content: { source: 'inline-text', mode: 'replace', text: 'Intro\n\nDetails' },
    });
    const plan = planPresetApplication(preset, createEditorSnapshot());
    expect(plan.status).toBe('ready');
    expect(plan.actions[0]).toMatchObject({ field: 'body', op: 'set', status: 'apply' });
    const body = JSON.parse(String(plan.actions[0]?.value));
    expect(body.root.children).toHaveLength(3);
    expect(body.root.children[0].children[0].text).toBe('Intro');
    expect(body.root.children[1].children).toEqual([]);
  });
});
