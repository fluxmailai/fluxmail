import { describe, expect, it } from 'vitest';
import { FOLDER_ROLES, folderPathLevels, newFolderName } from '../src/index.js';

describe('newFolderName', () => {
  it('trims a folder name', () => {
    expect(newFolderName('  Receipts ')).toBe('Receipts');
    expect(newFolderName('Projects/2026')).toBe('Projects/2026');
  });

  it.each(['', '   ', '\t'])('rejects the blank name %j', (name) => {
    expect(() => newFolderName(name)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('rejects control characters', () => {
    expect(() => newFolderName('Line\nbreak')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => newFolderName('Null\u0000')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('rejects every folder role in any case', () => {
    for (const role of FOLDER_ROLES) {
      for (const name of [role, role.toUpperCase(), ` ${role[0]!.toUpperCase()}${role.slice(1)} `]) {
        expect(() => newFolderName(name), name).toThrow(
          expect.objectContaining({ code: 'invalid_request', message: expect.stringContaining('system folder') }),
        );
      }
    }
  });

  it('allows a role word inside a longer name', () => {
    expect(newFolderName('Inbox zero')).toBe('Inbox zero');
    expect(newFolderName('Projects/Archive')).toBe('Projects/Archive');
  });
});

describe('folderPathLevels', () => {
  it('splits a path at the mailbox separator', () => {
    expect(folderPathLevels('Projects/2026', '/')).toEqual(['Projects', '2026']);
    expect(folderPathLevels(' Projects / 2026 ', '/')).toEqual(['Projects', '2026']);
    expect(folderPathLevels('INBOX.Projects.2026', '.')).toEqual(['INBOX', 'Projects', '2026']);
    expect(folderPathLevels('Projects/2026', '.')).toEqual(['Projects/2026']);
  });

  it('keeps the whole name when the mailbox has no separator', () => {
    expect(folderPathLevels('Projects/2026', undefined)).toEqual(['Projects/2026']);
  });

  it.each(['Projects/', '/Projects', 'Projects//2026', 'Projects/ /2026'])('rejects the empty level in %j', (path) => {
    expect(() => folderPathLevels(path, '/')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});
