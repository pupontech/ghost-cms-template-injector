import { describe, expect, it } from 'vitest';
import { plainTextToLexical } from '../../src/plain-text-lexical';

describe('plainTextToLexical', () => {
  it('converts each line to a Lexical paragraph and preserves blank lines', () => {
    const serialized = plainTextToLexical('First line\n\nSecond line');
    expect(JSON.parse(serialized)).toEqual({
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'First line',
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
          {
            children: [],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'Second line',
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    });
  });

  it('preserves special characters as text, not markup', () => {
    const parsed = JSON.parse(plainTextToLexical('<script>alert("x")</script> & <b>plain</b>'));
    expect(parsed.root.children[0].children[0].text).toBe(
      '<script>alert("x")</script> & <b>plain</b>',
    );
    expect(parsed.root.children[0].children[0].type).toBe('text');
  });

  it('rejects an empty template instead of creating an accidental empty body', () => {
    expect(() => plainTextToLexical('')).toThrow(/empty/i);
    expect(() => plainTextToLexical('   \n  ')).toThrow(/empty/i);
  });
});
