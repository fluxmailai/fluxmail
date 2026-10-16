import { EmailError, isEmailError, networkFailure, type FailurePhase, type ProviderFailure } from '@fluxmail/core';

const IMAPFLOW_REASONS: Record<string, ProviderFailure['reason']> = {
  CONNECT_TIMEOUT: 'connection_timeout',
  UPGRADE_TIMEOUT: 'connection_timeout',
  ETIMEOUT: 'connection_timeout',
  NoConnection: 'connection_reset',
  EConnectionClosed: 'connection_reset',
  StateLogout: 'connection_reset',
  InvalidResponse: 'invalid_response',
  ParserErrorExchange: 'invalid_response',
  LineTooLarge: 'invalid_response',
  LiteralTooLarge: 'invalid_response',
};

/**
 * Map an ImapFlow or Nodemailer error to an EmailError. `phase` names the step
 * that failed. An EmailError keeps any failure detail it already has.
 */
export function mapImapError(error: unknown, phase?: FailurePhase): EmailError {
  const base: ProviderFailure = { provider: 'imap', ...(phase ? { phase } : {}) };
  if (isEmailError(error)) {
    error.failure = { ...base, ...error.failure };
    return error;
  }
  const value = error as {
    code?: string;
    responseStatus?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    message?: string;
  };
  const message = value?.message ?? String(error);
  // ImapFlow reports every NO/BAD reply as "Command failed" and puts the server's reason in responseText.
  const detail = value?.responseText ? `${message} (${value.responseStatus ?? 'NO'}: ${value.responseText})` : message;
  const network = networkFailure(error);
  const failure: ProviderFailure = { ...base, ...(network?.ioCode ? { ioCode: network.ioCode } : {}) };
  if (value?.authenticationFailed || value?.code === 'EAUTH' || /auth|credential|login/i.test(message)) {
    return new EmailError('auth_expired', `IMAP/SMTP authentication failed: ${detail}`, undefined, failure);
  }
  if (value?.code === 'EENVELOPE' || value?.code === 'EMESSAGE') {
    return new EmailError('invalid_request', message, undefined, failure);
  }
  // A TLS client on a plaintext port gets a malformed record. A plaintext client
  // on an implicit TLS port never sees the server greeting.
  if (
    value?.code === 'GREETING_TIMEOUT' ||
    /wrong version number|packet length too long|greeting never received/i.test(message)
  ) {
    return new EmailError(
      'provider_unavailable',
      `IMAP/SMTP operation failed: ${detail}. Check that the security mode matches the port: tls for implicit TLS ports such as 993 and 465, starttls for ports such as 143 and 587.`,
      undefined,
      { ...failure, reason: 'tls_mismatch' },
    );
  }
  return new EmailError('provider_unavailable', `IMAP/SMTP operation failed: ${detail}`, undefined, {
    ...failure,
    reason: unavailableReason(value, network?.reason),
  });
}

function unavailableReason(
  value: { code?: string; responseStatus?: string; responseText?: string } | undefined,
  networkReason: ProviderFailure['reason'],
): NonNullable<ProviderFailure['reason']> {
  if (value?.responseStatus === 'BAD') return 'server_bad';
  if (value?.responseStatus === 'NO' || value?.responseText) return 'server_no';
  if (networkReason) return networkReason;
  return (value?.code && IMAPFLOW_REASONS[value.code]) || 'other';
}
