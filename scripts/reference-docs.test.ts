import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { generateCliReference, generateMcpReference } from './reference-docs.js';

describe('MCP documentation generation', () => {
  it('creates an index and one page for each tool', () => {
    const reference = generateMcpReference(
      [
        {
          name: 'list_emails',
          description: 'List messages in a mailbox.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Mailbox to use.' },
              recipients: { type: 'array', items: { type: 'string' } },
              cc: { $ref: '#/properties/recipients', description: 'Carbon-copy recipients.' },
              pageSize: { type: 'integer', minimum: 1 },
            },
            required: ['pageSize'],
          },
        },
      ],
      new Map([['list_emails', [['mail.read']]]]),
      '2026-07-15',
    );

    expect(reference.meta).toContain('"pagesIndex": "index"');
    expect(reference.indexSection).toContain('](/docs/tools/list-emails)');
    expect(reference.pages.get('list-emails.md')).toContain('Required capabilities: `mail.read`.');
    expect(reference.pages.get('list-emails.md')).toContain(
      '| `cc` | No | array of `string` | Carbon-copy recipients. |',
    );
    expect(reference.pages.get('list-emails.md')).toContain('| `pageSize` | Yes | `integer` | Minimum: 1. |');
  });

  it('documents tools available without capabilities', () => {
    const reference = generateMcpReference(
      [{ name: 'send_feedback', inputSchema: { type: 'object', properties: {} } }],
      new Map([['send_feedback', [[]]]]),
      '2026-10-27',
    );
    expect(reference.pages.get('send-feedback.md')).toContain('Required capabilities: None.');
    expect(reference.indexSection).toContain('| None |');
  });

  it('documents nullable types and retains constraints from the value branch', () => {
    const reference = generateMcpReference(
      [
        {
          name: 'list_emails',
          inputSchema: {
            type: 'object',
            properties: {
              subject: { type: ['string', 'null'] },
              read: { type: ['boolean', 'null'] },
              pageSize: {
                description: 'Number of messages.',
                anyOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { type: 'null' }],
              },
              folder: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
              recipients: { type: ['array', 'null'], items: { type: 'string' } },
            },
          },
        },
      ],
      new Map(),
      '2026-10-04',
    );

    const page = reference.pages.get('list-emails.md');
    expect(page).toContain('| `subject` | No | `string` or `null` | None |');
    expect(page).toContain('| `read` | No | `boolean` or `null` | None |');
    expect(page).toContain('| `pageSize` | No | `integer` or `null` | Number of messages. Minimum: 1. Maximum: 100. |');
    expect(page).toContain('| `folder` | No | `string` or `null` | Minimum length: 1. |');
    expect(page).toContain('| `recipients` | No | array of `string` or `null` | None |');
  });
});

describe('CLI documentation generation', () => {
  it('documents command arguments, options, defaults, and subcommands', () => {
    const program = new Command().name('fluxmail');
    const accounts = program.command('accounts').description('Manage accounts');
    accounts
      .command('add')
      .description('Add an account')
      .argument('<provider>', 'Provider name')
      .requiredOption('--owner <member>', 'Mailbox owner')
      .option('--port <port>', 'Server port', '993');

    const reference = generateCliReference(program, '2026-07-15');
    expect(reference.indexSection).toContain('](/docs/cli/accounts-add)');
    expect(reference.pages.get('accounts.md')).toContain('## Subcommands');
    expect(reference.pages.get('accounts-add.md')).toContain('fluxmail accounts add <provider> [options]');
    expect(reference.pages.get('accounts-add.md')).toContain('| `provider` | Yes | Provider name | None |');
    expect(reference.pages.get('accounts-add.md')).toContain('| `--owner <member>` | Yes | Mailbox owner | None |');
    expect(reference.pages.get('accounts-add.md')).toContain('| `--port <port>` | No | Server port | `993` |');
  });
});
