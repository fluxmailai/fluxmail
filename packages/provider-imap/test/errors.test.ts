import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { EmailError } from '@fluxmail/core';
import { mapImapError, watchConnectionErrors } from '../src/errors.js';

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

  const imapLogin = (serverResponseCode?: string) =>
    Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseStatus: 'NO',
      responseText: 'Login refused',
      ...(serverResponseCode ? { serverResponseCode } : {}),
    });

  const smtpLogin = (responseCode?: number) =>
    Object.assign(new Error('Invalid login'), { code: 'EAUTH', ...(responseCode ? { responseCode } : {}) });

  it.each(['LIMIT', 'UNAVAILABLE'])('reports an IMAP login refused with %s as rate limited', (serverResponseCode) => {
    const error = mapImapError(imapLogin(serverResponseCode), 'connect');
    expect(error).toMatchObject({
      code: 'rate_limited',
      message: 'IMAP/SMTP login temporarily refused: Command failed (NO: Login refused)',
    });
    expect(error.failure).toEqual({ provider: 'imap', phase: 'connect', reason: 'server_no' });
  });

  it.each(['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED', 'PRIVACYREQUIRED', undefined])(
    'keeps an IMAP login refused with %s as an auth failure',
    (serverResponseCode) => {
      const error = mapImapError(imapLogin(serverResponseCode), 'connect');
      expect(error).toMatchObject({ code: 'auth_expired' });
      expect(error.failure).toEqual({ provider: 'imap', phase: 'connect' });
    },
  );

  it('does not match throttling text in a plain IMAP NO', () => {
    const error = Object.assign(imapLogin(), { responseText: 'Too many login attempts, try again later' });
    expect(mapImapError(error, 'connect')).toMatchObject({ code: 'auth_expired' });
  });

  it.each(['LineTooLarge', 'LiteralTooLarge', 'ResponseTooLarge'])(
    'reports an oversized server reply (%s) as an invalid response',
    (code) => {
      const error = Object.assign(new Error('Too large'), { code });
      expect(mapImapError(error, 'fetch')).toMatchObject({
        code: 'provider_unavailable',
        failure: { reason: 'invalid_response' },
      });
    },
  );

  it('applies temporary IMAP codes only to login failures', () => {
    const error = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: 'Too many results',
      serverResponseCode: 'LIMIT',
    });
    expect(mapImapError(error, 'search')).toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'server_no' },
    });
  });

  it.each([421, 454])('reports an SMTP %i login reply as rate limited', (responseCode) => {
    const error = mapImapError(smtpLogin(responseCode), 'smtp');
    expect(error).toMatchObject({
      code: 'rate_limited',
      message: 'IMAP/SMTP login temporarily refused: Invalid login',
    });
    expect(error.failure).toEqual({ provider: 'imap', phase: 'smtp', reason: 'other' });
  });

  it.each([334, 500, 535, 554, undefined])('keeps an SMTP %s login reply as an auth failure', (responseCode) => {
    const error = mapImapError(smtpLogin(responseCode), 'smtp');
    expect(error).toMatchObject({ code: 'auth_expired' });
    expect(error.failure).toEqual({ provider: 'imap', phase: 'smtp' });
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

  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ])('explains how to trust a server certificate that fails with %s', (code) => {
    const error = mapImapError(Object.assign(new Error('self-signed certificate'), { code }), 'connect');
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(error.message).toContain('IMAP/SMTP operation failed: self-signed certificate.');
    expect(error.message).toContain("Fluxmail couldn't verify the server's certificate chain.");
    expect(error.message).toContain('NODE_EXTRA_CA_CERTS');
    expect(error.message).toContain(
      'https://fluxmail.ai/docs/troubleshooting#the-mail-servers-certificate-isnt-trusted',
    );
    expect(error.failure).toEqual({ provider: 'imap', phase: 'connect', reason: 'tls_untrusted', ioCode: code });
  });

  it('explains an untrusted SMTP certificate reported the way Nodemailer reports it', () => {
    const smtp = Object.assign(new Error('self-signed certificate'), {
      code: 'ESOCKET',
      originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    const error = mapImapError(smtp, 'smtp');
    expect(error.message).toContain('NODE_EXTRA_CA_CERTS');
    expect(error.failure).toEqual({
      provider: 'imap',
      phase: 'smtp',
      reason: 'tls_untrusted',
      ioCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
  });

  it('explains an untrusted certificate found on a wrapped cause', () => {
    const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const error = mapImapError(new Error('Connection failed', { cause }), 'connect');
    expect(error.failure).toMatchObject({ reason: 'tls_untrusted' });
    expect(error.message).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('keeps an expired certificate as a general TLS failure', () => {
    const error = mapImapError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }));
    expect(error.message).toBe('IMAP/SMTP operation failed: certificate has expired');
    expect(error.failure).toMatchObject({ reason: 'tls_error' });
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

  // ImapFlow fails a command on a closed connection with an error naming only the connection.
  const connectionGone = (cid: string) =>
    Object.assign(new Error('Connection not available'), { code: 'NoConnection', cid });
  const watched = (id: string) => {
    const client = Object.assign(new EventEmitter(), { id });
    watchConnectionErrors(client as unknown as ImapFlow);
    return client;
  };

  it('keeps a closed connection as a reset when its cause is unrecognized', () => {
    watched('c-unknown').emit('error', new Error('Unexpected server reply'));
    const error = mapImapError(connectionGone('c-unknown'), 'fetch');
    expect(error.message).toBe('IMAP/SMTP operation failed: Connection not available (Unexpected server reply)');
    expect(error.failure).toEqual({ provider: 'imap', phase: 'fetch', reason: 'connection_reset' });
  });

  it('reads the cause recorded under the connection ID ImapFlow stamps on the error', () => {
    watched('c-listener').emit(
      'error',
      Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT', _connId: 'c-stamped' }),
    );
    expect(mapImapError(connectionGone('c-stamped'), 'fetch').failure).toMatchObject({ reason: 'connection_timeout' });
    expect(mapImapError(connectionGone('c-listener'), 'fetch').failure).toMatchObject({ reason: 'connection_reset' });
  });

  it('keeps the TLS setting hint to the failed command itself', () => {
    watched('c-tls').emit('error', new Error('wrong version number'));
    const error = mapImapError(connectionGone('c-tls'), 'fetch');
    expect(error.message).not.toMatch(/security mode/);
    expect(error.failure).toEqual({ provider: 'imap', phase: 'fetch', reason: 'connection_reset' });
  });

  it("forgets a connection's cause after a short time", () => {
    vi.useFakeTimers();
    try {
      watched('c-old').emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }));
      vi.advanceTimersByTime(10_000);
      expect(mapImapError(connectionGone('c-old'), 'fetch').failure).toMatchObject({ reason: 'connection_reset' });
    } finally {
      vi.useRealTimers();
    }
  });
});
