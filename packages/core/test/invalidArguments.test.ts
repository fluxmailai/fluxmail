import { describe, expect, it } from 'vitest';
import {
  INVALID_ARGUMENT_REASONS,
  invalidArgumentProperties,
  orderedArgumentProblems,
  sharedTool,
} from '../src/mcp/index.js';

const schema = {
  type: 'object',
  properties: {
    messageId: { type: 'string' },
    bodyFormat: { anyOf: [{ type: 'string', enum: ['text', 'html'] }, { type: 'null' }] },
    query: {
      anyOf: [
        {
          type: 'object',
          properties: { after: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
        },
        { type: 'null' },
      ],
    },
    accounts: {
      type: 'array',
      items: { type: 'object', properties: { accountId: { type: 'string' } }, additionalProperties: false },
    },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

describe('invalidArgumentProperties', () => {
  it('reports schema-declared paths with fixed array and map steps', () => {
    expect(invalidArgumentProperties(schema, [{ code: 'invalid_format', path: ['query', 'after'] }], {})).toEqual({
      invalid_argument: 'query.after',
      invalid_reason: 'invalid_format',
      invalid_argument_count: 1,
    });
    expect(invalidArgumentProperties(schema, [{ code: 'too_big', path: ['query', 'labels', 41] }], {})).toMatchObject({
      invalid_argument: 'query.labels[]',
      invalid_reason: 'too_big',
    });
    expect(
      invalidArgumentProperties(schema, [{ code: 'invalid_type', path: ['headers', 'X-Private-ann@example.com'] }], {
        headers: { 'X-Private-ann@example.com': 1 },
      }),
    ).toMatchObject({ invalid_argument: 'headers.unrecognized_key', invalid_reason: 'wrong_type' });
  });

  it('replaces invented keys with a placeholder and puts them first', () => {
    const properties = invalidArgumentProperties(
      schema,
      [
        { code: 'invalid_type', path: ['messageId'] },
        { code: 'unrecognized_keys', path: [], keys: ['ann@example.com', 'secret'] },
        { code: 'unrecognized_keys', path: ['accounts', 3], keys: ['Quarterly report subject'] },
      ],
      { 'ann@example.com': 'x', secret: 5, accounts: [] },
    );
    expect(properties).toEqual({
      invalid_argument: 'unrecognized_key',
      invalid_reason: 'unknown_field',
      invalid_argument_count: 4,
    });
    expect(
      invalidArgumentProperties(schema, [{ code: 'unrecognized_keys', path: ['accounts', 3], keys: ['secret'] }], {}),
    ).toMatchObject({ invalid_argument: 'accounts[].unrecognized_key' });
  });

  it('prefers an undeclared key it can name, whatever order the client sent', () => {
    for (const keys of [
      ['ann@example.com', 'limit'],
      ['limit', 'ann@example.com'],
    ])
      expect(
        invalidArgumentProperties(
          schema,
          [
            { code: 'invalid_type', path: ['messageId'] },
            { code: 'unrecognized_keys', path: [], keys },
          ],
          {},
        ),
      ).toEqual({ invalid_argument: 'limit', invalid_reason: 'unknown_field', invalid_argument_count: 3 });
  });

  it('orders undeclared keys before other problems', () => {
    expect(
      orderedArgumentProblems([
        { code: 'too_big', path: ['messageIds'] },
        { code: 'unrecognized_keys', path: [], keys: ['a', 'b'] },
      ]).map((problem) => [problem.path.join('.'), problem.unknownKey]),
    ).toEqual([
      ['a', true],
      ['b', true],
      ['messageIds', false],
    ]);
  });

  it('reports allowlisted names that models commonly send without declaring them', () => {
    expect(invalidArgumentProperties(schema, [{ code: 'unrecognized_keys', path: [], keys: ['limit'] }], {})).toEqual({
      invalid_argument: 'limit',
      invalid_reason: 'unknown_field',
      invalid_argument_count: 1,
    });
    // A name another shared tool declares is schema-derived too.
    expect(
      invalidArgumentProperties(schema, [{ code: 'unrecognized_keys', path: [], keys: ['includeSearchContext'] }], {}),
    ).toMatchObject({ invalid_argument: 'includeSearchContext' });
  });

  it('tells missing arguments from wrong types without reporting values', () => {
    expect(invalidArgumentProperties(schema, [{ code: 'invalid_type', path: ['messageId'] }], {})).toMatchObject({
      invalid_argument: 'messageId',
      invalid_reason: 'missing',
    });
    expect(
      invalidArgumentProperties(schema, [{ code: 'invalid_type', path: ['messageId'] }], { messageId: 42 }),
    ).toMatchObject({ invalid_reason: 'wrong_type' });
    expect(
      invalidArgumentProperties(schema, [{ code: 'invalid_union', path: ['bodyFormat'] }], { bodyFormat: 'markdown' }),
    ).toMatchObject({ invalid_argument: 'bodyFormat', invalid_reason: 'invalid_value' });
    expect(invalidArgumentProperties(schema, [{ code: 'invalid_type', path: [] }], [])).toMatchObject({
      invalid_argument: 'arguments',
      invalid_reason: 'wrong_type',
    });
  });

  it('maps every issue code to a fixed reason', () => {
    const reasons = ['too_small', 'too_big', 'invalid_value', 'custom', 'not_multiple_of', 'something_new'].map(
      (code) => invalidArgumentProperties(schema, [{ code, path: ['messageId'] }], { messageId: 'x' })?.invalid_reason,
    );
    expect(reasons).toEqual(['too_small', 'too_big', 'invalid_value', 'invalid_value', 'invalid_value', 'other']);
    for (const reason of reasons) expect(INVALID_ARGUMENT_REASONS).toContain(reason);
    expect(invalidArgumentProperties(schema, [], {})).toBeUndefined();
  });

  it('works with the shared tool schemas', () => {
    const { inputSchema } = sharedTool('get_email_body');
    expect(
      invalidArgumentProperties(inputSchema, [{ code: 'invalid_value', path: ['bodyFormat'] }], { bodyFormat: 'md' }),
    ).toMatchObject({ invalid_argument: 'bodyFormat', invalid_reason: 'invalid_value' });
  });
});
