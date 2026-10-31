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

  it.each([
    "Hostname/IP does not match certificate's altnames: Host: login.example.com",
    'getaddrinfo ENOTFOUND auth.example.com',
    'Unsupported credential format',
  ])('does not treat an unflagged error as an auth failure (%s)', (message) => {
    expect(mapImapError({ message })).toMatchObject({ code: 'provider_unavailable' });
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

  it.each([
    [
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      { reason: 'connection_refused', ioCode: 'ECONNREFUSED' },
    ],
    [{ code: 'NoConnection', message: 'Connection not available' }, { reason: 'connection_reset' }],
    [{ code: 'GREETING_TIMEOUT', message: 'no greeting' }, { reason: 'tls_mismatch' }],
    [{ message: 'Command failed', responseStatus: 'NO', responseText: 'private' }, { reason: 'server_no' }],
    [{ message: 'Command failed', responseStatus: 'BAD', responseText: 'private' }, { reason: 'server_bad' }],
    [{ code: 'EPRIVATE', message: 'something else' }, { reason: 'other' }],
  ] as const)('records why the provider failed (%s)', (input, failure) => {
    expect(mapImapError(input, 'search').failure).toEqual({ provider: 'imap', phase: 'search', ...failure });
  });

  it('adds the provider and phase to an EmailError without replacing its detail', () => {
    const error = new EmailError('provider_unavailable', 'x', undefined, {
      phase: 'select',
      reason: 'invalid_response',
    });
    expect(mapImapError(error, 'fetch').failure).toEqual({
      provider: 'imap',
      phase: 'select',
      reason: 'invalid_response',
    });
  });
});
