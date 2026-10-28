import { z } from 'zod';
import { VERSION } from './version.js';
import { FeedbackError } from './service/publicErrors.js';

export const DEFAULT_FEEDBACK_CLOUD_ORIGIN = 'https://cloud.fluxmail.ai';
const MAX_BYTES = 32 * 1024;
const versionSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);

export const feedbackShape = {
  message: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => !!value.trim() && !value.includes('\0'), {
      message: 'Write a feedback message.',
    }),
  // Cloud defaults omitted categories and rejects null.
  category: z.enum(['bug', 'feature', 'other']).default('other'),
};
const inputSchema = z.object(feedbackShape).strict();
const resultSchema = z
  .object({
    feedbackId: z.string().min(1).max(512),
    message: feedbackShape.message,
    category: z.enum(['bug', 'feature', 'other']),
    product: z.literal('self_hosted'),
    version: versionSchema.optional(),
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
  if (!parsed.success) throw new FeedbackError('invalid_request', 'Check the feedback message and category.');
  const { message, category } = parsed.data;
  const version = versionSchema.safeParse(VERSION);
  const payload = {
    message,
    category,
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
        throw new FeedbackError('invalid_request', 'The feedback service rejected the message or category.');
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
    const result = z.object({ data: resultSchema }).strict().safeParse(JSON.parse(text));
    if (
      !result.success ||
      result.data.data.message !== message ||
      result.data.data.category !== category ||
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
