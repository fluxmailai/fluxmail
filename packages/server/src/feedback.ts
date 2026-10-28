import { z } from 'zod';
import { VERSION } from './version.js';
import { FeedbackError } from './service/publicErrors.js';

export const DEFAULT_FEEDBACK_CLOUD_ORIGIN = 'https://cloud.fluxmail.ai';
const MAX_BYTES = 32 * 1024;
const versionSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);
const nonBlankText = z
  .string()
  .min(1)
  // eslint-disable-next-line no-control-regex -- Feedback text must reject NUL while preserving other text.
  .regex(/^(?!\s*$)[^\0]+$/, 'Use nonblank text without NUL.');

const feedbackDetailsShape = {
  contactEmail: z
    .string()
    .max(320)
    .email()
    // eslint-disable-next-line no-control-regex -- Reject control characters and header injection without normalizing the address.
    .regex(/^[^\s\x00-\x1f\x7f]+$/)
    .describe('Optional reply address confirmed by the user. Never choose a connected mailbox address automatically.')
    .optional(),
  requestId: z.string().uuid().describe('The related failed request ID, when available. Do not invent one.').optional(),
  toolName: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .describe('The tool involved in the reported problem.')
    .optional(),
  errorCode: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .describe('The safe error code returned by that tool, without its error message.')
    .optional(),
  expectedBehavior: nonBlankText
    .max(1000)
    .describe('What the user expected. Exclude mail contents and credentials.')
    .optional(),
  actualBehavior: nonBlankText
    .max(1000)
    .describe('What happened instead. Exclude mail contents and credentials.')
    .optional(),
};
export const feedbackShape = {
  message: nonBlankText.max(4000).describe('The feedback text approved by the user.'),
  // Cloud defaults omitted categories and rejects null.
  category: z.enum(['bug', 'feature', 'other']).default('other'),
  ...feedbackDetailsShape,
};
const inputSchema = z.object(feedbackShape).strict();
export const feedbackResultSchema = z
  .object({
    feedbackId: z.string().min(1).max(512),
    message: feedbackShape.message,
    category: z.enum(['bug', 'feature', 'other']),
    product: z.literal('self_hosted'),
    version: versionSchema.optional(),
    ...feedbackDetailsShape,
  })
  .strict();

export interface FeedbackOptions {
  enabled?: boolean;
  cloudOrigin?: string;
}

export function feedbackCloudOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FLUXMAIL_FEEDBACK_CLOUD_ORIGIN must be an HTTP or HTTPS origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'FLUXMAIL_FEEDBACK_CLOUD_ORIGIN must be an HTTP or HTTPS origin without credentials, path, query or fragment.',
    );
  }
  return url.origin;
}

const unavailable = () =>
  new FeedbackError(
    'provider_unavailable',
    'Feedback submission could not be confirmed. It may have been received. Do not retry automatically.',
  );

/** One explicit submission. Never retry: a lost response may follow a saved report. */
export async function submitFeedback(input: unknown, options: FeedbackOptions = {}, cancellation?: AbortSignal) {
  if (options.enabled === false) {
    throw new FeedbackError('permission_denied', 'Feedback submissions are disabled by the instance administrator.');
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new FeedbackError('invalid_request', 'Check the feedback message, category, reply address and diagnostics.');
  const { message, category } = parsed.data;
  const version = versionSchema.safeParse(VERSION);
  const payload = {
    ...parsed.data,
    product: 'self_hosted' as const,
    ...(version.success ? { version: version.data } : {}),
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_BYTES) {
    throw new FeedbackError('invalid_request', 'Feedback exceeds the 32 KiB request limit.');
  }
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(cancellation ? [cancellation] : [])]);
  try {
    signal.throwIfAborted();
    const response = await fetch(
      `${feedbackCloudOrigin(options.cloudOrigin ?? DEFAULT_FEEDBACK_CLOUD_ORIGIN)}/api/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
        redirect: 'error',
        credentials: 'omit',
      },
    );
    if (response.status !== 201) {
      await response.body?.cancel();
      if (response.status === 400)
        throw new FeedbackError('invalid_request', 'The feedback service rejected the submitted fields.');
      if (response.status === 413)
        throw new FeedbackError('invalid_request', 'Feedback exceeds the service request limit.');
      if (response.status === 429)
        throw new FeedbackError('rate_limited', 'The feedback limit has been reached. Try again in an hour.');
      throw unavailable();
    }
    // Bound the response too. Never return unknown fields or remote error bodies.
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw unavailable();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const result = z.object({ data: feedbackResultSchema }).strict().safeParse(JSON.parse(text));
    if (
      !result.success ||
      result.data.data.message !== message ||
      result.data.data.category !== category ||
      result.data.data.contactEmail !== parsed.data.contactEmail ||
      result.data.data.version !== payload.version
    )
      throw unavailable();
    return result.data.data;
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    // Transport errors can contain URLs or credentials. Discard their messages and causes.
    throw unavailable();
  }
}
