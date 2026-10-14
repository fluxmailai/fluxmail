import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { mapImapError } from '../src/errors.js';

describe('IMAP error mapping', () => {
  it.each([
    [{ code: 'EAUTH', message: 'bad password' }, 'auth_expired'],
    [{ authenticationFailed: true, message: 'login rejected' }, 'auth_expired'],
    [{ code: 'EENVELOPE', message: 'bad recipient' }, 'invalid_request'],
    [{ code: 'ECONNRESET', message: 'connection reset' }, 'provider_unavailable'],
  ] as const)('maps provider failures to EmailError (%s)', (input, code) => {
    expect(mapImapError(input)).toMatchObject({ code });
  });

  it('includes the IMAP server reply for failed commands', () => {
    const error = Object.assign(new Error('Command failed'), {
      responseStatus: 'BAD',
      responseText: 'Message contains bare newlines',
    });
    expect(mapImapError(error)).toMatchObject({
      code: 'provider_unavailable',
      message: 'IMAP/SMTP operation failed: Command failed (BAD: Message contains bare newlines)',
    });
  });

  it.each([
    { code: 'ESOCKET', message: 'ssl3_get_record:wrong version number' },
    { code: 'ETIMEDOUT', message: 'Greeting never received' },
    { code: 'GREETING_TIMEOUT', message: 'Failed to receive greeting from server in required time' },
  ])('suggests checking the security mode for a TLS mismatch (%s)', (input) => {
    expect(mapImapError(input)).toMatchObject({
      code: 'provider_unavailable',
      message: expect.stringContaining('Check that the security mode matches the port'),
    });
  });

  it('preserves an existing EmailError', () => {
    const error = new EmailError('not_found', 'gone');
    expect(mapImapError(error)).toBe(error);
  });
});
