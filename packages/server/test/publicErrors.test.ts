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
});
