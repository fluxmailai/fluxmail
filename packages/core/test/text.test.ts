import { describe, expect, it } from 'vitest';
import { findByFolderName, folderNameKey, withoutTrailingLineBreaks } from '../src/index.js';

it('removes only the line breaks that end a text body', () => {
  expect(withoutTrailingLineBreaks('Done.\r\n\r\n')).toBe('Done.');
  expect(withoutTrailingLineBreaks('Done.\n')).toBe('Done.');
  expect(withoutTrailingLineBreaks('Line one\r\n\r\nLine two  ')).toBe('Line one\r\n\r\nLine two  ');
  expect(withoutTrailingLineBreaks('\r\n')).toBe('');
});

// A quadratic implementation takes minutes on this input, so the test timeout catches a regression.
it('handles a long run of line breaks before more text', () => {
  const text = `${'\n'.repeat(200_000)}end${'\r\n'.repeat(200_000)}`;
  expect(withoutTrailingLineBreaks(text)).toBe(`${'\n'.repeat(200_000)}end`);
});

describe('folderNameKey', () => {
  it('gives both Unicode forms of an accented name the same key', () => {
    expect(folderNameKey('Réunions'.normalize('NFD'))).toBe(folderNameKey('Réunions'));
    expect(folderNameKey('ÉQUIPE', true)).toBe(folderNameKey('équipe'.normalize('NFD'), true));
  });

  it('keeps case and accents that change the name', () => {
    expect(folderNameKey('Équipe')).not.toBe(folderNameKey('équipe'));
    expect(folderNameKey('Réunions', true)).not.toBe(folderNameKey('Reunions', true));
  });
});

describe('findByFolderName', () => {
  const decomposed = 'Réunions'.normalize('NFD');
  const name = (value: string) => value;

  it('matches a name in the other Unicode form', () => {
    expect(findByFolderName([decomposed], 'Réunions', name)).toBe(decomposed);
    expect(findByFolderName(['Réunions'], decomposed, name)).toBe('Réunions');
  });

  it('prefers the exact name when an account keeps both forms', () => {
    expect(findByFolderName(['Réunions', decomposed], decomposed, name)).toBe(decomposed);
    expect(findByFolderName(['RÉUNIONS', 'réunions'], 'réunions', name, true)).toBe('réunions');
  });

  it('ignores case only when asked and skips items without a name', () => {
    expect(findByFolderName(['Réunions'], 'réunions', name)).toBeUndefined();
    expect(findByFolderName([{ name: null }, { name: decomposed }], 'RÉUNIONS', (item) => item.name, true)).toEqual({
      name: decomposed,
    });
  });
});
