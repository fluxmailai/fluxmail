import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentFolder } from '../src/mcp/attachmentFolder.js';

let base: string;
let root: string;
let folder: AttachmentFolder;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fluxmail-attachments-')));
  root = path.join(base, 'shared');
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports', 'q3.pdf'), 'pdf bytes');
  writeFileSync(path.join(base, 'secret.txt'), 'secret');
  folder = AttachmentFolder.open(root);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('AttachmentFolder', () => {
  it('refuses a missing folder or a file at startup', () => {
    expect(() => AttachmentFolder.open(path.join(base, 'missing'))).toThrow();
    expect(() => AttachmentFolder.open(path.join(base, 'secret.txt'))).toThrow();
  });

  it('reads a file inside the folder as an attachment', async () => {
    await expect(folder.read({ path: 'reports/q3.pdf' }, 1_000)).resolves.toEqual({
      filename: 'q3.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('pdf bytes').toString('base64'),
    });
    await expect(
      folder.read(
        { path: path.join(root, 'reports', 'q3.pdf'), filename: 'Report.pdf', mimeType: 'application/x-pdf' },
        1_000,
      ),
    ).resolves.toMatchObject({ filename: 'Report.pdf', mimeType: 'application/x-pdf' });
  });

  it('refuses files outside the folder, including through symbolic links', async () => {
    symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
    for (const file of ['../secret.txt', path.join(base, 'secret.txt'), 'link.txt', '/etc/hosts']) {
      await expect(folder.read({ path: file }, 1_000)).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('accepts names inside the folder that start with two dots', async () => {
    writeFileSync(path.join(root, '..notes.txt'), 'notes');
    await expect(folder.read({ path: '..notes.txt' }, 1_000)).resolves.toMatchObject({ filename: '..notes.txt' });
  });

  it('opens a folder typed in another letter case on a case-insensitive disk', async () => {
    const typed = root.replace(/shared$/, 'SHARED');
    let caseInsensitive = true;
    try {
      realpathSync(typed);
    } catch {
      caseInsensitive = false;
    }
    if (!caseInsensitive) return;
    await expect(AttachmentFolder.open(typed).read({ path: 'reports/q3.pdf' }, 1_000)).resolves.toMatchObject({
      filename: 'q3.pdf',
    });
  });

  it('names the folder by its path under the home directory, and keeps the full path out of errors', async () => {
    expect(folder.label).toBeUndefined();
    expect(folder.described).toBe('the attachment folder');
    await expect(folder.read({ path: '../secret.txt' }, 1_000)).rejects.not.toThrow(root);
    await expect(folder.read({ path: 'missing.pdf' }, 1_000)).rejects.not.toThrow(root);
  });

  it('refuses folders, missing files and files over the limit', async () => {
    await expect(folder.read({ path: 'reports' }, 1_000)).rejects.toThrow('is not a file');
    await expect(folder.read({ path: 'missing.pdf' }, 1_000)).rejects.toThrow('No file');
    await expect(folder.read({ path: 'reports/q3.pdf' }, 3)).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 9, maxBytes: 3 },
    });
  });

  it('saves a new file and refuses to replace one', async () => {
    // The temporary folder is outside the home directory, so the saved file is shown relative to the folder.
    expect(await folder.write('reports/q4.pdf', Buffer.from('new'))).toBe('reports/q4.pdf');
    expect(readFileSync(path.join(root, 'reports', 'q4.pdf'), 'utf8')).toBe('new');
    await expect(folder.write('reports/q3.pdf', Buffer.from('x'))).rejects.toThrow('already exists');
    expect(readFileSync(path.join(root, 'reports', 'q3.pdf'), 'utf8')).toBe('pdf bytes');
  });

  it('refuses to save outside the folder or through a symbolic link', async () => {
    symlinkSync(base, path.join(root, 'up'));
    symlinkSync(path.join(base, 'elsewhere.txt'), path.join(root, 'dangling.txt'));
    for (const file of ['../escape.txt', 'up/escape.txt', path.join(base, 'escape.txt'), 'missing/q.pdf', '.']) {
      await expect(folder.write(file, Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(folder.write('dangling.txt', Buffer.from('x'))).rejects.toThrow('already exists');
    expect(() => readFileSync(path.join(base, 'escape.txt'))).toThrow();
    expect(() => readFileSync(path.join(base, 'elsewhere.txt'))).toThrow();
  });

  it('reads a saved file back by the path the save returned', async () => {
    vi.stubEnv('HOME', base);
    try {
      const home = AttachmentFolder.open(root);
      const saved = await home.write('reports/q4.pdf', Buffer.from('new'));
      expect(saved).toBe('~/shared/reports/q4.pdf');
      await expect(home.read({ path: saved }, 1_000)).resolves.toMatchObject({ filename: 'q4.pdf' });
      await expect(home.read({ path: '~/secret.txt' }, 1_000)).rejects.toThrow('No file');
      await expect(home.read({ path: '~/shared/../secret.txt' }, 1_000)).rejects.toThrow(
        'outside the attachment folder',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('starts when the home directory does not exist', () => {
    vi.stubEnv('HOME', path.join(base, 'no-home'));
    try {
      expect(AttachmentFolder.open(root).label).toBeUndefined();
      expect(AttachmentFolder.planned(path.join(base, 'later')).described).toBe('the attachment folder');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('tells whether it holds a directory', () => {
    expect(AttachmentFolder.open(base).holds(root)).toBe(true);
    expect(folder.holds(base)).toBe(false);
  });
});
