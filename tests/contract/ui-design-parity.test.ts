import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The popup is the same surface family as the Options and Setup pages: the
 * owner asked for the popup's UI to match the settings pages, so the design
 * tokens and the component vocabulary must not drift apart again. These tests
 * fail the build when one page's palette or button/card conventions change
 * without the others.
 */
const root = resolve(process.cwd());

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

/** Extract the light + dark custom-property blocks verbatim. */
function tokenBlocks(html: string): { light: string; dark: string } {
  const light = /:root \{\s*\n([\s\S]*?)\n {6}\}/.exec(html);
  const dark =
    /@media \(prefers-color-scheme: dark\) \{\s*\n\s*:root \{\s*\n([\s\S]*?)\n\s{8}\}/.exec(html);
  return { light: light?.[1] ?? '', dark: dark?.[1] ?? '' };
}

const PAGES = ['popup/popup.html', 'options/options.html', 'setup/setup.html'] as const;

describe('extension surface design parity', () => {
  it('ships exactly the same palette tokens on every extension page', () => {
    const reference = tokenBlocks(read(PAGES[1]));
    expect(reference.light).not.toBe('');
    expect(reference.dark).not.toBe('');

    for (const page of PAGES) {
      const tokens = tokenBlocks(read(page));
      expect(tokens.light, `${page} light tokens`).toBe(reference.light);
      expect(tokens.dark, `${page} dark tokens`).toBe(reference.dark);
    }
  });

  it('styles the popup with the settings page vocabulary, not its own', () => {
    const popup = read('popup/popup.html');
    // Page background, card surface and shared radius — the three things the
    // popup previously did differently (it painted the body with --surface and
    // had no --bg/--surface-2/--radius at all).
    expect(popup).toMatch(/body \{[\s\S]*?background: var\(--bg\);/);
    expect(popup).toMatch(
      /\.card \{[\s\S]*?background: var\(--surface\);[\s\S]*?border-radius: var\(--radius\);/,
    );
    expect(popup).toContain('--surface-2');
    expect(popup).toContain('--radius');
    // Uppercase micro-labels for section headings, like the Options page.
    expect(popup).toMatch(/h2 \{[\s\S]*?text-transform: uppercase;/);
    // One accent colour: the primary action is the accent, the secondary is a
    // hairline button — no custom hover glows or gradients.
    expect(popup).toMatch(/#gcti-import-open \{[\s\S]*?background: var\(--accent\);/);
    expect(popup).toMatch(/#gcti-undo \{[\s\S]*?border: 1px solid var\(--line\);/);
    expect(popup).not.toMatch(/gradient|box-shadow: 0 0 2[0-9]px/);
  });

  it('keeps the popup controls the scripts resolve by id', () => {
    const popup = read('popup/popup.html');
    for (const id of [
      'gcti-status',
      'gcti-preset-list',
      'gcti-plan-panel',
      'gcti-plan-list',
      'gcti-plan-apply',
      'gcti-plan-cancel',
      'gcti-prompt-panel',
      'gcti-prompt-list',
      'gcti-prompt-yes',
      'gcti-prompt-no',
      'gcti-undo',
      'gcti-import-open',
    ]) {
      expect(popup, `${id} must stay in the popup`).toContain(`id="${id}"`);
    }
    // Hidden panels must actually hide (the popup sets the attribute, and the
    // stylesheet must not override it).
    expect(popup).toMatch(/section\[hidden\] \{\s*\n\s*display: none;/);
  });
});
