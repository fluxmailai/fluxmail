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
  folderAlreadyThere,
  FolderMoveRefusedError,
  folderMovedIntoItself,
  movedFolderTakesRole,
  folderNameTaken,
  FolderRenameRefusedError,
  newFolderName,
  renamedFolderName,
  newLabelName,
  systemFolderNotDeletable,
  systemFolderNotMovable,
  systemFolderNotRenamable,
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

describe('renamedFolderName', () => {
  it('trims the new name', () => {
    expect(renamedFolderName('  Invoices ', '/')).toBe('Invoices');
  });

  it('allows a role word, which providers check against the full path', () => {
    expect(renamedFolderName('Sent', '/')).toBe('Sent');
  });

  it.each(['', '   ', 'a\nb', 'a\u007fb'])('rejects %j', (name) => {
    expect(() => renamedFolderName(name, '/')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it("rejects the mailbox's separator, since a rename keeps the folder under its parent", () => {
    expect(() => renamedFolderName('Money/Receipts', '/')).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        message:
          'The new name can\'t contain "/", which this mailbox uses between folder levels. A rename keeps the folder under the same parent, so give only the folder\'s own name.',
      }),
    );
    expect(renamedFolderName('Money/Receipts', '.')).toBe('Money/Receipts');
    expect(renamedFolderName('Money/Receipts', undefined)).toBe('Money/Receipts');
  });
});

describe('folder rename refusals', () => {
  it('are FolderNameErrors, so products pass their messages through', () => {
    for (const error of [systemFolderNotRenamable('INBOX'), folderNameTaken('Invoices')]) {
      expect(error).toBeInstanceOf(FolderNameError);
      expect(error).toBeInstanceOf(FolderRenameRefusedError);
      expect(error.code).toBe('invalid_request');
    }
  });

  it('say why the folder keeps its name', () => {
    expect(systemFolderNotRenamable('Trash').message).toBe('"Trash" is a system folder and can\'t be renamed.');
    expect(folderNameTaken('Invoices').message).toBe('A folder named "Invoices" already exists. Choose another name.');
  });
});

describe('folder move refusals', () => {
  it('are FolderNameErrors, so products pass their messages through', () => {
    for (const error of [systemFolderNotMovable('INBOX'), folderMovedIntoItself('Projects', 'Projects')]) {
      expect(error).toBeInstanceOf(FolderNameError);
      expect(error).toBeInstanceOf(FolderMoveRefusedError);
      expect(error.code).toBe('invalid_request');
    }
  });

  it('say why the folder stays where it is', () => {
    expect(folderAlreadyThere('Archive/Receipts').message).toBe(
      'A folder named "Archive/Receipts" already exists there. Rename one of the two before moving.',
    );
    expect(movedFolderTakesRole('Sent').message).toBe(
      'At its new place the folder would be named "Sent", which is a system folder name. Rename the folder before moving it.',
    );
    expect(systemFolderNotMovable('Trash').message).toBe('"Trash" is a system folder and can\'t be moved.');
    expect(folderMovedIntoItself('Projects', 'Projects').message).toBe('"Projects" can\'t be moved into itself.');
    expect(folderMovedIntoItself('Projects', 'Projects/2025').message).toBe(
      '"Projects/2025" is inside "Projects", so "Projects" can\'t be moved into it.',
    );
  });
});
