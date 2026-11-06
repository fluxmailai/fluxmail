---
title: 'forward_email'
description: 'Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again. Add sendAt to schedule the forward instead of sending it now.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again. Add sendAt to schedule the forward instead of sending it now.

## Permissions

Required capabilities: `mail.read` + `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `idempotencyKey` | Yes | `string` | Reuse this key when retrying the same forward |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |
| `from` | No | `string` or `null` | Connected address or an available send-as address Format: `email`. |
| `to` | Yes | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `bcc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `comment` | No | `string` or `null` | Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines. |
| `includeAttachments` | No | `boolean` or `null` | Default true |
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
      "description": "Reuse this key when retrying the same forward"
    },
    "accountId": {
      "description": "Account to operate on. Optional when exactly one account is connected.",
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        {
          "type": "null"
        }
      ]
    },
    "messageId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "from": {
      "description": "Connected address or an available send-as address",
      "anyOf": [
        {
          "type": "string",
          "format": "email"
        },
        {
          "type": "null"
        }
      ]
    },
    "to": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "cc": {
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\"",
      "anyOf": [
        {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ]
    },
    "bcc": {
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\"",
      "anyOf": [
        {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ]
    },
    "comment": {
      "description": "Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines.",
      "type": [
        "string",
        "null"
      ]
    },
    "includeAttachments": {
      "description": "Default true",
      "type": [
        "boolean",
        "null"
      ]
    },
    "sendAt": {
      "description": "Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z (e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox for delivery by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not deliver schedules. Overdue mail may send when a worker starts. Returns a scheduleId for list/cancel.",
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "messageId",
    "to"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
