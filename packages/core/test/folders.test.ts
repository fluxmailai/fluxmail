import { describe, expect, it } from 'vitest';
import {
  FolderDeleteRefusedError,
  folderHasMessages,
  folderHasSubfolders,
  FolderNameError,
  FolderNotFoundError,
  FOLDER_ROLES,
  folderPathLevels,
  LabelNotFoundError,
  newFolderName,
  newLabelName,
  systemFolderNotDeletable,
} from '../src/index.js';

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

describe('folder deletion refusals', () => {
  it('are FolderNameErrors, so products pass their messages through', () => {
    for (const error of [
      folderHasMessages('Receipts', 12),
      folderHasSubfolders('Projects'),
      systemFolderNotDeletable('INBOX'),
      new FolderNotFoundError('Missing'),
    ]) {
      expect(error).toBeInstanceOf(FolderNameError);
    }
    expect(folderHasMessages('Receipts', 12)).toBeInstanceOf(FolderDeleteRefusedError);
  });

  it('say why the folder stays and what to do', () => {
    expect(folderHasMessages('Receipts', 12)).toMatchObject({
      code: 'invalid_request',
      message: '"Receipts" still has 12 messages. Move or trash them first.',
    });
    expect(folderHasMessages('Receipts', 1).message).toBe('"Receipts" still has 1 message. Move or trash it first.');
    expect(folderHasMessages('Receipts', 2, true).message).toBe(
      '"Receipts" still has 2 messages. Remove the label from them first.',
    );
    expect(folderHasMessages('Receipts', 1, true).message).toBe(
      '"Receipts" still has 1 message. Remove the label from it first.',
    );
    expect(folderHasSubfolders('Projects').message).toBe('"Projects" has subfolders. Delete them first.');
    expect(systemFolderNotDeletable('Trash').message).toBe('"Trash" is a system folder and can\'t be deleted.');
    expect(new FolderNotFoundError('Missing')).toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Missing".',
    });
  });

  it('keep invalid_request as the default code', () => {
    expect(new FolderNameError('x').code).toBe('invalid_request');
    expect(new FolderNameError('x', undefined, 'permission_denied').code).toBe('permission_denied');
  });
});

describe('label names', () => {
  it('trims a label name and rejects blank names and control characters', () => {
    expect(newLabelName('  Clients ')).toBe('Clients');
    expect(() => newLabelName('  ')).toThrow('The label name is empty.');
    expect(() => newLabelName(' ', 'category')).toThrow('The category name is empty.');
    expect(() => newLabelName('Bad\u0007', 'category')).toThrow('Category names cannot contain control characters.');
  });

  it('names only what the caller asked for when a label is missing', () => {
    const error = new LabelNotFoundError('Clients', 'category');
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({ code: 'not_found', message: 'This mailbox has no category named "Clients".' });
    expect(new LabelNotFoundError('Clients').message).toBe('This mailbox has no label named "Clients".');
  });
});
