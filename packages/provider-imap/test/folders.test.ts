import { describe, expect, it } from 'vitest';
import type { ListResponse } from 'imapflow';
import { findMailboxPath, resolveFolders } from '../src/folders.js';

function folder(path: string, specialUse?: string, specialUseSource?: ListResponse['specialUseSource']): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split('/').at(-1)!,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set(),
    ...(specialUse ? { specialUse } : {}),
    ...(specialUseSource ? { specialUseSource } : {}),
    listed: true,
    subscribed: true,
  };
}

describe('resolveFolders', () => {
  it('prefers a valid user path over extension and name matches', () => {
    const result = resolveFolders(
      [folder('INBOX'), folder('Server Sent', '\\Sent'), folder('Sent'), folder('Custom')],
      { sent: 'Custom' },
    );
    expect(result.paths.sent).toBe('Custom');
    expect(result.folders.find((item) => item.id === 'Custom')).toMatchObject({
      role: 'sent',
      roleSource: 'user',
    });
  });

  it('uses extension flags before conservative name matching', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent', '\\Archive'), folder('Delivery', '\\Sent')]);
    expect(result.paths.sent).toBe('Delivery');
    expect(result.paths.archive).toBe('Sent');
  });

  it('does not guess when multiple folders claim a role', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent A', '\\Sent'), folder('Sent B', '\\Sent')]);
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'ambiguous' }));
  });

  it('treats duplicate conservative name matches as ambiguous', () => {
    const result = resolveFolders([folder('INBOX'), folder('Team/Sent'), folder('Legacy/Sent')]);
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'ambiguous' }));
  });

  it('marks a missing override as stale without falling back', () => {
    const result = resolveFolders([folder('INBOX'), folder('Sent', '\\Sent')], { sent: 'Old Sent' });
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'stale_override' }));
  });

  it('ignores non-selectable folders', () => {
    const drafts = folder('Drafts', '\\Drafts');
    drafts.flags.add('\\Noselect');
    expect(resolveFolders([folder('INBOX'), drafts]).paths.drafts).toBeUndefined();
  });

  it('excludes Spam and Trash descendants from the All Mail fallback', () => {
    expect(
      resolveFolders([
        folder('INBOX'),
        folder('Projects'),
        folder('Junk', '\\Junk'),
        folder('Junk/Review'),
        folder('Trash', '\\Trash'),
        folder('Trash/Receipts'),
      ]).allMailPaths,
    ).toEqual(['INBOX', 'Projects']);
  });

  it('reports every unresolved optional role without making the account unhealthy', () => {
    const result = resolveFolders([folder('INBOX')]);
    expect(result.paths).toEqual({ inbox: 'INBOX' });
    expect(result.warnings.map((warning) => [warning.role, warning.reason])).toEqual([
      ['sent', 'missing'],
      ['drafts', 'missing'],
      ['trash', 'missing'],
      ['archive', 'missing'],
      ['spam', 'missing'],
    ]);
  });

  it('resolves a folder role guessed from a localized name as a name match', () => {
    const result = resolveFolders([folder('INBOX'), folder('Gesendet', '\\Sent', 'name')]);
    expect(result.paths.sent).toBe('Gesendet');
    expect(result.folders.find((item) => item.id === 'Gesendet')).toMatchObject({ role: 'sent', roleSource: 'name' });
  });

  it('prefers a server flag over a role guessed from a folder name', () => {
    const result = resolveFolders([
      folder('INBOX'),
      folder('Sent Messages', '\\Sent', 'extension'),
      folder('Gesendet', '\\Sent', 'name'),
    ]);
    expect(result.paths.sent).toBe('Sent Messages');
    expect(result.folders.find((item) => item.id === 'Sent Messages')).toMatchObject({ roleSource: 'extension' });
  });

  it('warns instead of guessing when a guessed name and a common name both look like the folder', () => {
    const result = resolveFolders([folder('INBOX'), folder('Gesendet', '\\Sent', 'name'), folder('Sent')]);
    expect(result.paths.sent).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ role: 'sent', reason: 'ambiguous' }));
  });
});

describe('findMailboxPath', () => {
  const composed = 'Réunions';
  const decomposed = composed.normalize('NFD');

  it("returns the server's spelling for a name typed in the other Unicode form", () => {
    expect(findMailboxPath(['INBOX', decomposed], composed)).toBe(decomposed);
    expect(findMailboxPath(['INBOX', composed], decomposed)).toBe(composed);
  });

  it('prefers an exact match when the server lists both forms', () => {
    expect(findMailboxPath([composed, decomposed], decomposed)).toBe(decomposed);
    expect(findMailboxPath([decomposed, composed], composed)).toBe(composed);
  });

  it('still requires the same letters and case', () => {
    expect(findMailboxPath([composed], 'Reunions')).toBeUndefined();
    expect(findMailboxPath([composed], 'réunions')).toBeUndefined();
  });
});
