---
title: 'Send email'
description: 'Send an email from a connected mailbox. There are three modes: direct (to, subject and body), an existing draft (draftId), or a reply (replyToMessageId, optionally with replyAll) that takes its recipients, subject and threading from the original. Repeating a successful send with the same idempotencyKey and arguments returns the saved result instead of sending again. Reusing a key with different arguments, or after a failed or uncertain send, returns an error. Confirm with the user when the intent is ambiguous. Add sendAt to any mode to schedule the message instead of sending it now.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`send_email`

Send an email from a connected mailbox. There are three modes: direct (to, subject and body), an existing draft (draftId), or a reply (replyToMessageId, optionally with replyAll) that takes its recipients, subject and threading from the original. Repeating a successful send with the same idempotencyKey and arguments returns the saved result instead of sending again. Reusing a key with different arguments, or after a failed or uncertain send, returns an error. Confirm with the user when the intent is ambiguous. Add sendAt to any mode to schedule the message instead of sending it now.

## Permissions

Required capabilities: `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `idempotencyKey` | Yes | `string` | Reuse this key when retrying the same delivery |
| `draftId` | No | `string` or `null` | Send this existing draft Minimum length: 1. |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `from` | No | `string` or `null` | Connected address or an available send-as address Format: `email`. |
| `to` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `bcc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `subject` | No | `string` or `null` | Defaults to "Re: ..." when replying |
| `bodyText` | No | `string` or `null` | Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines. |
| `bodyHtml` | No | `string` or `null` | HTML body |
| `replyToMessageId` | No | `string` or `null` | Message being replied to; threads correctly and computes recipients if "to" is omitted Minimum length: 1. |
| `replyAll` | No | `boolean` or `null` | With replyToMessageId: reply to all original recipients |
| `attachments` | No | array of `object` or `null` | None |
| `sendAt` | No | `string` or `null` | Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z (e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox for delivery by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not deliver schedules. Overdue mail may send when a worker starts. Returns a scheduleId for list/cancel. Format: `date-time`. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "pattern": "^[\\x21-\\x7e]{1,255}$",
      "description": "Reuse this key when retrying the same delivery"
    },
    "draftId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Send this existing draft"
    },
    "accountId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "from": {
      "anyOf": [
        {
          "type": "string",
          "format": "email"
        },
        {
          "type": "null"
        }
      ],
      "description": "Connected address or an available send-as address"
    },
    "to": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "cc": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "bcc": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "subject": {
      "type": [
        "string",
        "null"
      ],
      "description": "Defaults to \"Re: ...\" when replying"
    },
    "bodyText": {
      "type": [
        "string",
        "null"
      ],
      "description": "Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines."
    },
    "bodyHtml": {
      "type": [
        "string",
        "null"
      ],
      "description": "HTML body"
    },
    "replyToMessageId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Message being replied to; threads correctly and computes recipients if \"to\" is omitted"
    },
    "replyAll": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "With replyToMessageId: reply to all original recipients"
    },
    "attachments": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "filename": {
                "type": "string",
                "minLength": 1
              },
              "mimeType": {
                "type": "string",
                "minLength": 1
              },
              "content": {
                "type": "string",
                "description": "base64"
              },
              "contentId": {
                "type": "string",
                "minLength": 1,
                "description": "Content-ID for an inline image, referenced from bodyHtml as cid:<contentId>"
              },
              "disposition": {
                "type": "string",
                "enum": [
                  "inline",
                  "attachment"
                ],
                "description": "Defaults to attachment"
              }
            },
            "required": [
              "filename",
              "mimeType",
              "content"
            ],
            "additionalProperties": false
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "sendAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ],
      "description": "Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z (e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox for delivery by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not deliver schedules. Overdue mail may send when a worker starts. Returns a scheduleId for list/cancel."
    }
  },
  "required": [
    "idempotencyKey"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
