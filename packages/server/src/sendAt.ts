import { z } from 'zod';

const DATE = z.regexes.date.source.slice(1, -1);
// Zod's datetime() requires seconds and a colon in the offset. resolveSendAt parses both forms.
const TIMESTAMP = new RegExp(`^${DATE}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$`);

/** An ISO 8601 timestamp with a timezone offset or Z. */
export const sendAtSchema = z
  .string()
  .refine((value) => TIMESTAMP.test(value), 'Invalid datetime')
  .meta({ format: 'date-time' });
