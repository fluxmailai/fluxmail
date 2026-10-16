import { EmailError, networkFailure, type FailurePhase, type ProviderFailure } from '@fluxmail/core';

export interface GraphErrorLike {
  status?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

export class GraphHttpError extends Error implements GraphErrorLike {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GraphHttpError';
  }
}

export function isRetryableGraphError(err: unknown): boolean {
  const status = (err as GraphErrorLike).status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Map a Graph or network error to an EmailError. `phase` applies when the error has none yet. */
export function toEmailError(err: unknown, phase: FailurePhase = 'request'): EmailError {
  if (err instanceof EmailError) {
    err.failure = { provider: 'outlook', phase, ...err.failure };
    return err;
  }
  const graph = err as GraphErrorLike;
  const message = graph.message ?? 'Microsoft Graph request failed';
  const failure: ProviderFailure = {
    provider: 'outlook',
    phase,
    ...(graph.status !== undefined ? { httpStatus: graph.status } : {}),
    ...(networkFailure(err) ?? { reason: graph.status !== undefined ? 'http_error' : 'other' }),
  };
  if (graph.status === 401 || /InvalidAuthenticationToken|invalid_grant/i.test(graph.code ?? message)) {
    return new EmailError(
      'auth_expired',
      `Microsoft authorization expired or was revoked: ${message}`,
      undefined,
      failure,
    );
  }
  if (graph.status === 429 || graph.code === 'ErrorQuotaExceeded') {
    const retryAfterMs = graph.retryAfterMs;
    return new EmailError(
      'rate_limited',
      `Microsoft Graph rate limit hit: ${message}`,
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? { retryAfterMs }
        : undefined,
      failure,
    );
  }
  if (graph.status === 403 || graph.code === 'ErrorAccessDenied') {
    return new EmailError('permission_denied', `Microsoft Graph denied this operation: ${message}`, undefined, failure);
  }
  if (graph.status === 404 || graph.code === 'ErrorItemNotFound') {
    return new EmailError('not_found', `Not found in Microsoft Graph: ${message}`, undefined, failure);
  }
  if (graph.status === 400 || graph.status === 409 || graph.status === 412) {
    return new EmailError('invalid_request', `Microsoft Graph rejected the request: ${message}`, undefined, failure);
  }
  return new EmailError('provider_unavailable', `Microsoft Graph unavailable: ${message}`, undefined, failure);
}
