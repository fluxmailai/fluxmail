import { expect, it } from 'vitest';
import { withoutTrailingLineBreaks } from '../src/index.js';

it('removes only the line breaks that end a text body', () => {
  expect(withoutTrailingLineBreaks('Done.\r\n\r\n')).toBe('Done.');
  expect(withoutTrailingLineBreaks('Done.\n')).toBe('Done.');
  expect(withoutTrailingLineBreaks('Line one\r\n\r\nLine two  ')).toBe('Line one\r\n\r\nLine two  ');
  expect(withoutTrailingLineBreaks('\r\n')).toBe('');
});

it('handles a long run of line breaks before more text in linear time', () => {
  const text = `${'\n'.repeat(200_000)}end${'\r\n'.repeat(200_000)}`;
  const started = performance.now();
  expect(withoutTrailingLineBreaks(text)).toBe(`${'\n'.repeat(200_000)}end`);
  expect(performance.now() - started).toBeLessThan(500);
});
