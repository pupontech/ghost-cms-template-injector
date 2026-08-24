/**
 * Convert owner-authored plain text into the smallest Ghost-compatible Lexical
 * document we can safely author without accepting HTML or arbitrary JSON.
 *
 * Semantics: CRLF/CR becomes LF; every line is one paragraph; blank lines are
 * retained as empty paragraphs. Text is stored only in Lexical text nodes, so
 * characters such as `<` never become markup or executable content.
 */

const MAX_TEMPLATE_CHARS = 100_000;

interface LexicalTextNode {
  detail: 0;
  format: 0;
  mode: 'normal';
  style: '';
  text: string;
  type: 'text';
  version: 1;
}

interface LexicalParagraph {
  children: LexicalTextNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
  type: 'paragraph';
  version: 1;
}

export function plainTextToLexical(text: string): string {
  if (typeof text !== 'string') throw new TypeError('plain text template must be a string');
  if (text.length > MAX_TEMPLATE_CHARS) {
    throw new RangeError(`plain text template exceeds ${MAX_TEMPLATE_CHARS} characters`);
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.trim().length === 0) throw new TypeError('plain text template cannot be empty');

  const children: LexicalParagraph[] = normalized.split('\n').map((line) => ({
    children:
      line.length > 0
        ? [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text: line,
              type: 'text',
              version: 1,
            },
          ]
        : [],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  }));

  return JSON.stringify({
    root: {
      children,
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

export const MAX_PLAIN_TEXT_TEMPLATE_CHARS = MAX_TEMPLATE_CHARS;
