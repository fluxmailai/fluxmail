import { describe, expect, it } from 'vitest';
import { sendAtSchema } from '../src/sendAt.js';

describe('sendAtSchema', () => {
  it.each([
    '2026-11-02T09:00:00Z',
    '2026-11-02T09:00:00.123456789+02:00',
    '2026-11-02T09:00Z',
    '2026-11-02T09:00+02:00',
    '2026-11-02T09:00:00+0200',
    '2028-02-29T09:00:00Z',
  ])('accepts %s', (value) => {
    expect(sendAtSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-11-02T09:00:00',
    '2026-11-02T09:00:00+02',
    '2026-11-02T09:00:00z',
    '2026-11-02 09:00:00Z',
    '2026-02-30T09:00:00Z',
    '2026-02-29T09:00:00Z',
    '2026-11-02T24:00:00Z',
    '2026-11-02T09:00:60Z',
  ])('rejects %s', (value) => {
    expect(sendAtSchema.safeParse(value).success).toBe(false);
  });
});
