import { EmailError, isEmailError, networkFailure, type FailurePhase, type ProviderFailure } from '@fluxmail/core';
import type { ImapFlow } from 'imapflow';

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

const UNTRUSTED_CERTIFICATE_GUIDE =
  'https://fluxmail.ai/docs/troubleshooting#the-mail-servers-certificate-isnt-trusted';

/**
 * Why recent connections closed, by ImapFlow connection ID. ImapFlow reports a
 * socket error or its own socket timeout as an 'error' event, then fails the
 * command in flight with an error that says only that the connection is gone.
 */
const closeCauses = new Map<string, Error>();
const MAX_CLOSE_CAUSES = 256;
/** The failed command is mapped as the connection closes, so a cause isn't needed for long. */
const CLOSE_CAUSE_MS = 10_000;

/** Listen for a client's errors and remember them, so a failed command can report why its connection closed. */
export function watchConnectionErrors(client: ImapFlow): void {
  client.on('error', (error: unknown) => {
    const id = (error as { _connId?: unknown })._connId ?? client.id;
    if (typeof id !== 'string' || !(error instanceof Error)) return;
    closeCauses.delete(id);
    closeCauses.set(id, error);
    if (closeCauses.size > MAX_CLOSE_CAUSES) closeCauses.delete(closeCauses.keys().next().value!);
    setTimeout(() => {
      if (closeCauses.get(id) === error) closeCauses.delete(id);
    }, CLOSE_CAUSE_MS).unref();
  });
}

/** The error that closed the connection, for ImapFlow's "connection is gone" errors. */
function closeCause(error: unknown): Error | undefined {
  const value = error as { code?: unknown; cid?: unknown } | undefined;
  if (value?.code !== 'NoConnection' && value?.code !== 'EConnectionClosed') return undefined;
  return typeof value.cid === 'string' ? closeCauses.get(value.cid) : undefined;
}

/** RFC 5530 response codes for a login refused for a temporary reason. */
const TEMPORARY_LOGIN_CODES = new Set(['LIMIT', 'UNAVAILABLE']);

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
    serverResponseCode?: string;
    responseCode?: number;
    message?: string;
  };
  const cause = closeCause(error);
  const original = value?.message ?? String(error);
  const message = cause ? `${original} (${cause.message})` : original;
  // ImapFlow reports every NO/BAD reply as "Command failed" and puts the server's reason in responseText.
  const detail = value?.responseText ? `${message} (${value.responseStatus ?? 'NO'}: ${value.responseText})` : message;
  const network = networkFailure(cause ?? error);
  const failure: ProviderFailure = { ...base, ...(network?.ioCode ? { ioCode: network.ioCode } : {}) };
  if (value?.authenticationFailed || value?.code === 'EAUTH') {
    if (isTemporaryLoginFailure(value)) {
      return new EmailError('rate_limited', `IMAP/SMTP login temporarily refused: ${detail}`, undefined, {
        ...failure,
        reason: unavailableReason(value, network?.reason),
      });
    }
    return new EmailError('auth_expired', `IMAP/SMTP authentication failed: ${detail}`, undefined, failure);
  }
  if (value?.code === 'EENVELOPE' || value?.code === 'EMESSAGE') {
    return new EmailError('invalid_request', message, undefined, failure);
  }
  // A TLS client on a plaintext port gets a malformed record. A plaintext client
  // on an implicit TLS port never sees the server greeting.
  if (
    value?.code === 'GREETING_TIMEOUT' ||
    /wrong version number|packet length too long|greeting never received/i.test(original)
  ) {
    return new EmailError(
      'provider_unavailable',
      `IMAP/SMTP operation failed: ${detail}. Check that the security mode matches the port: tls for implicit TLS ports such as 993 and 465, starttls for ports such as 143 and 587.`,
      undefined,
      { ...failure, reason: 'tls_mismatch' },
    );
  }
  if (network?.reason === 'tls_untrusted') {
    return new EmailError(
      'provider_unavailable',
      `IMAP/SMTP operation failed: ${detail}. Fluxmail couldn't verify the server's certificate chain. The certificate may be self-signed, or the server may not be sending its intermediate certificates. If you trust this server, such as a mail bridge on this computer, set NODE_EXTRA_CA_CERTS to a file with its certificate before starting Fluxmail. See ${UNTRUSTED_CERTIFICATE_GUIDE}.`,
      undefined,
      { ...failure, reason: 'tls_untrusted' },
    );
  }
  return new EmailError('provider_unavailable', `IMAP/SMTP operation failed: ${detail}`, undefined, {
    ...failure,
    reason: closedReason(cause, network?.reason) ?? unavailableReason(value, network?.reason),
  });
}

/** Why the connection closed, when its cause is recognized. */
function closedReason(
  cause: Error | undefined,
  networkReason: ProviderFailure['reason'],
): ProviderFailure['reason'] | undefined {
  if (!cause) return undefined;
  const reason = unavailableReason(cause as { code?: string }, networkReason);
  return reason === 'other' ? undefined : reason;
}

/** A server that throttles with a plain NO or a 5xx reply looks like a wrong password here. */
function isTemporaryLoginFailure(value: {
  code?: string;
  serverResponseCode?: string;
  responseCode?: number;
}): boolean {
  if (value.code === 'EAUTH') {
    const reply = value.responseCode ?? 0;
    return reply >= 400 && reply < 500;
  }
  return TEMPORARY_LOGIN_CODES.has(value.serverResponseCode ?? '');
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
