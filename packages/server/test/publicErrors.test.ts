import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { ClientInputError, MissingCapabilityError, publicError } from '../src/service/publicErrors.js';

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
