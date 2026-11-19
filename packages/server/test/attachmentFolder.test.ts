import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('refuses folders, missing files and files over the limit', async () => {
    await expect(folder.read({ path: 'reports' }, 1_000)).rejects.toThrow('is not a file');
    await expect(folder.read({ path: 'missing.pdf' }, 1_000)).rejects.toThrow('No file');
    await expect(folder.read({ path: 'reports/q3.pdf' }, 3)).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 9, maxBytes: 3 },
    });
  });

  it('saves a new file and refuses to replace one', async () => {
    const saved = await folder.write('reports/q4.pdf', Buffer.from('new'));
    expect(saved).toBe(path.join(root, 'reports', 'q4.pdf'));
    expect(readFileSync(saved, 'utf8')).toBe('new');
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
});
