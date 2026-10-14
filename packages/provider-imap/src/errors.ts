import { EmailError, isEmailError } from '@fluxmail/core';

export function mapImapError(error: unknown): EmailError {
  if (isEmailError(error)) return error;
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
  if (value?.authenticationFailed || value?.code === 'EAUTH' || /auth|credential|login/i.test(message)) {
    return new EmailError('auth_expired', `IMAP/SMTP authentication failed: ${detail}`);
  }
  if (value?.code === 'EENVELOPE' || value?.code === 'EMESSAGE') {
    return new EmailError('invalid_request', message);
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
    );
  }
  return new EmailError('provider_unavailable', `IMAP/SMTP operation failed: ${detail}`);
}
