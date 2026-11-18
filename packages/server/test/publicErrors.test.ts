import { describe, expect, it } from 'vitest';
import {
  EmailError,
  folderHasMessages,
  folderHasSubfolders,
  FolderNameError,
  folderNameTaken,
  FolderNotFoundError,
  systemFolderNotRenamable,
  systemFolderNotDeletable,
} from '@fluxmail/core';
import {
  ClientInputError,
  folderDestination,
  MissingCapabilityError,
  ModifyRejectionError,
  publicError,
} from '../src/service/publicErrors.js';

describe('public errors', () => {
  it('keeps Fluxmail input guidance and search diagnostics', () => {
    const diagnostics = [{ code: 'conflicting_filter', severity: 'error', message: 'Choose one sender.' }];
    expect(
      publicError(new ClientInputError('invalid_request', 'Choose one sender.', { diagnostics }), 'request_1'),
    ).toEqual({
      code: 'invalid_request',
      message: 'Choose one sender.',
      requestId: 'request_1',
      data: { diagnostics },
    });
  });

  it('keeps the reason Fluxmail gives for a change the folders rule out', () => {
    expect(
      publicError(
        new ModifyRejectionError(
          'unsupported_capability',
          "Fluxmail can't tell which folder is this mailbox's trash, so it can't trash these messages.",
        ),
        'request_m',
      ),
    ).toEqual({
      code: 'unsupported_capability',
      message: "Fluxmail can't tell which folder is this mailbox's trash, so it can't trash these messages.",
      requestId: 'request_m',
    });
  });

  it('keeps the reason Fluxmail gives for a refused folder name, but not provider text', () => {
    expect(
      publicError(
        new FolderNameError('"Trash" is a system folder. Choose another name.', { provider: 'imap' }),
        'request_f',
      ),
    ).toEqual({
      code: 'invalid_request',
      message: '"Trash" is a system folder. Choose another name.',
      requestId: 'request_f',
    });
    expect(publicError(new EmailError('invalid_request', 'private server reply'), 'request_g').message).not.toContain(
      'private server reply',
    );
  });

  it('keeps the reasons Fluxmail gives for a folder it did not delete', () => {
    const cases: Array<[EmailError, string, string]> = [
      [
        folderHasMessages('Receipts', 12),
        'invalid_request',
        '"Receipts" still has 12 messages. Move or trash them first.',
      ],
      [folderHasSubfolders('Projects'), 'invalid_request', '"Projects" has subfolders. Delete them first.'],
      [systemFolderNotDeletable('INBOX'), 'invalid_request', '"INBOX" is a system folder and can\'t be deleted.'],
      [new FolderNotFoundError('Receipts'), 'not_found', 'This mailbox has no folder named "Receipts".'],
      [
        new FolderNameError(
          'The mail server does not allow deleting the folder "Shared".',
          undefined,
          'permission_denied',
        ),
        'permission_denied',
        'The mail server does not allow deleting the folder "Shared".',
      ],
    ];
    for (const [error, code, message] of cases) {
      expect(publicError(error, 'request_d')).toEqual({ code, message, requestId: 'request_d' });
    }
    expect(
      publicError(new EmailError('not_found', 'Not found in Microsoft Graph: private'), 'r').message,
    ).not.toContain('private');
  });

  it('keeps the reasons Fluxmail gives for a folder it did not rename', () => {
    const cases: Array<[EmailError, string, string]> = [
      [
        folderNameTaken('Invoices'),
        'invalid_request',
        'A folder named "Invoices" already exists. Choose another name.',
      ],
      [systemFolderNotRenamable('INBOX'), 'invalid_request', '"INBOX" is a system folder and can\'t be renamed.'],
      [
        new FolderNameError(
          'The mail server does not allow renaming the folder "Shared".',
          undefined,
          'permission_denied',
        ),
        'permission_denied',
        'The mail server does not allow renaming the folder "Shared".',
      ],
    ];
    for (const [error, code, message] of cases) {
      expect(publicError(error, 'request_r')).toEqual({ code, message, requestId: 'request_r' });
    }
  });

  it('reads one destination for a folder move, and says which is missing or extra', () => {
    expect(folderDestination('Archive', undefined)).toBe('Archive');
    expect(folderDestination('Archive', false)).toBe('Archive');
    expect(folderDestination(undefined, true)).toBeNull();
    expect(folderDestination(null, true)).toBeNull();
    for (const [parent, topLevel] of [
      [undefined, undefined],
      [undefined, false],
      [null, null],
    ] as const) {
      const error = (() => {
        try {
          return folderDestination(parent, topLevel);
        } catch (caught) {
          return caught;
        }
      })();
      expect(publicError(error, 'request_m')).toEqual({
        code: 'invalid_request',
        message: 'Give the destination folder as parent, or topLevel: true to move the folder to the top level.',
        requestId: 'request_m',
      });
    }
    expect(() => folderDestination('Archive', true)).toThrow('Give either parent or topLevel: true, not both.');
  });

  it('keeps missing capability guidance', () => {
    expect(
      publicError(new MissingCapabilityError('This API key does not allow: mail.send.', ['mail.send']), 'request_3'),
    ).toEqual({
      code: 'permission_denied',
      message: 'This API key does not allow: mail.send.',
      requestId: 'request_3',
      data: { missingCapabilities: ['mail.send'] },
    });
  });

  it('explains a search that reached its deadline', () => {
    const result = publicError(
      new EmailError(
        'provider_unavailable',
        'The search took too long. Try a narrower search, such as a date range or one folder.',
        { reason: 'search_timeout', exhausted: false },
        { provider: 'imap', phase: 'search', reason: 'search_timeout' },
      ),
      'request_5',
    );
    expect(result).toEqual({
      code: 'provider_unavailable',
      message: 'The search took too long. Try a narrower search, such as a date range or one folder.',
      requestId: 'request_5',
      data: { reason: 'search_timeout', exhausted: false },
    });
  });

  it('keeps other provider messages out of public errors', () => {
    const result = publicError(new EmailError('provider_unavailable', 'private provider detail'), 'request_6');
    expect(result).toEqual({
      code: 'provider_unavailable',
      message: 'The mail provider could not complete the request.',
      requestId: 'request_6',
    });
  });

  it('names the search options a provider cannot run', () => {
    const result = publicError(
      new EmailError('unsupported_capability', 'Unsupported search options for this provider: from', {
        unsupportedSearchOptions: ['from'],
      }),
      'request_4',
    );
    expect(result).toEqual({
      code: 'unsupported_capability',
      message: 'The provider does not support this operation.',
      requestId: 'request_4',
      data: { unsupportedSearchOptions: ['from'] },
    });
  });

  it('hides provider validation text and unapproved data', () => {
    const result = publicError(
      new EmailError('invalid_request', 'private provider response', { recipient: 'private@example.com' }),
      'request_2',
    );
    expect(result).toEqual({
      code: 'invalid_request',
      message: 'The mail provider rejected these arguments. Check them and any pageToken.',
      requestId: 'request_2',
    });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
  });

  it('tells the caller when the provider timed out without its message', () => {
    const result = publicError(
      new EmailError('provider_unavailable', 'Microsoft Graph unavailable: private detail', undefined, {
        provider: 'outlook',
        phase: 'request',
        reason: 'request_timeout',
      }),
      'request_4',
    );
    expect(result).toEqual({
      code: 'provider_unavailable',
      message: 'The mail provider took too long to respond.',
      requestId: 'request_4',
    });
  });

  it('points the caller to the fix for an untrusted server certificate without the provider message', () => {
    const result = publicError(
      new EmailError(
        'provider_unavailable',
        'IMAP/SMTP operation failed: self-signed certificate (imap.private.example)',
        undefined,
        {
          provider: 'imap',
          phase: 'connect',
          reason: 'tls_untrusted',
          ioCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        },
      ),
      'request_5',
    );
    expect(result).toEqual({
      code: 'provider_unavailable',
      message:
        "The mail server's certificate isn't trusted. See https://fluxmail.ai/docs/troubleshooting#the-mail-servers-certificate-isnt-trusted.",
      requestId: 'request_5',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('uses the same certificate message when a network proxy breaks trust for a Gmail request', () => {
    const result = publicError(
      new EmailError('provider_unavailable', 'Gmail request failed: private detail', undefined, {
        provider: 'gmail',
        phase: 'request',
        reason: 'tls_untrusted',
        ioCode: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
      'request_6',
    );
    expect(result.message).toBe(
      "The mail server's certificate isn't trusted. See https://fluxmail.ai/docs/troubleshooting#the-mail-servers-certificate-isnt-trusted.",
    );
  });
});
