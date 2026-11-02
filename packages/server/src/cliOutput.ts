import { EmailError } from '@fluxmail/core';

export type OutputFormat = 'json' | 'table' | 'ndjson';

export function parseOutputFormat(value: string): OutputFormat {
  if (value === 'json' || value === 'table' || value === 'ndjson') return value;
  throw new EmailError('invalid_request', '--format must be json, table, or ndjson.');
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replaceAll('\t', ' ').replaceAll('\n', ' ');
}

export function printOutput(
  envelope: { data: unknown; meta?: Record<string, unknown>; warnings?: string[] },
  format: OutputFormat,
): void {
  if (format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  if (format === 'ndjson') {
    if (Array.isArray(envelope.data)) {
      for (const item of envelope.data) console.log(JSON.stringify({ type: 'item', data: item }));
      if (envelope.meta || envelope.warnings)
        console.log(
          JSON.stringify({
            type: 'meta',
            ...(envelope.meta ? { meta: envelope.meta } : {}),
            ...(envelope.warnings ? { warnings: envelope.warnings } : {}),
          }),
        );
    } else {
      console.log(JSON.stringify(envelope));
    }
    return;
  }
  const rows = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  if (rows.length === 0) return;
  const keys = [
    ...new Set(
      rows.flatMap((row) => (row && typeof row === 'object' ? Object.keys(row as Record<string, unknown>) : ['value'])),
    ),
  ];
  console.log(keys.join('\t'));
  for (const row of rows) {
    const values: Record<string, unknown> =
      row && typeof row === 'object' ? (row as Record<string, unknown>) : { value: row };
    console.log(keys.map((key) => cell(values[key])).join('\t'));
  }
  if (envelope.meta?.nextPageToken) console.error(`Next page: ${String(envelope.meta.nextPageToken)}`);
  for (const warning of envelope.warnings ?? []) console.error(warning);
}

export function cliExitCode(code: string): number {
  if (
    [
      'invalid_request',
      'request_too_large',
      'not_found',
      'unsupported_capability',
      'idempotency_conflict',
      'unsupported_media_type',
      'unsupported_operation',
      'attachment_limit',
      'request_limit',
      'response_limit',
    ].includes(code)
  )
    return 2;
  if (['partial_failure', 'uncertain', 'idempotency_in_progress', 'send_outcome_unknown'].includes(code)) return 3;
  if (
    [
      'unauthorized',
      'permission_denied',
      'auth_expired',
      'entitlement_exceeded',
      'setup_required',
      'https_required',
      'subscription_required',
      'workspace_unavailable',
    ].includes(code)
  )
    return 4;
  if (
    [
      'provider_unavailable',
      'rate_limited',
      'request_failed',
      'request_timeout',
      'invalid_response',
      'busy',
      'deadline_exceeded',
      'hourly_limit_exceeded',
      'mailbox_busy',
      'unavailable',
    ].includes(code)
  )
    return 5;
  return 1;
}
