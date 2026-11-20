import { EmailError, type EmailErrorCode } from '@fluxmail/core';
import type { TelemetryProperties } from './telemetry.js';

const STARTUP_REASONS = [
  'instance_not_configured',
  'instance_not_found',
  'local_instance_required',
  'local_instance_ambiguous',
  'instance_config_read_failed',
  'instance_config_invalid_json',
  'credentials_read_failed',
  'credentials_invalid_json',
  'session_missing',
  'session_invalid',
  'attachment_dir_unavailable',
] as const;

export type CliStartupReason = (typeof STARTUP_REASONS)[number];
const SAFE_REASONS = new Set<string>(STARTUP_REASONS);
const SAFE_IO_CODES = new Set([
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ELOOP',
  'ENAMETOOLONG',
]);

export class CliStartupError extends EmailError {
  constructor(
    code: EmailErrorCode,
    message: string,
    readonly startupReason: CliStartupReason,
    readonly ioCode?: unknown,
  ) {
    super(code, message);
  }
}

export function cliStartupDiagnostics(error: unknown): TelemetryProperties {
  if (!(error instanceof CliStartupError) || !SAFE_REASONS.has(error.startupReason)) return {};
  return {
    startup_reason: error.startupReason,
    ...(error.startupReason.endsWith('_read_failed')
      ? {
          startup_io_code:
            typeof error.ioCode === 'string' && SAFE_IO_CODES.has(error.ioCode) ? error.ioCode : 'unknown',
        }
      : {}),
  };
}
