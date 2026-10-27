---
title: 'Forward email'
description: 'Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`forward_email`

Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again.

## Permissions

Required capabilities: `mail.read` + `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `idempotencyKey` | Yes | `string` | Reuse this key when retrying the same forward |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `messageId` | Yes | `string` | Minimum length: 1. |
| `from` | No | `string` or `null` | Connected address or an available send-as address Format: `email`. |
| `to` | Yes | array of `string` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `comment` | No | `string` or `null` | Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines. |
| `includeAttachments` | No | `boolean` or `null` | Default true |

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
    "messageId": {
      "type": "string",
      "minLength": 1
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
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1,
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
    "comment": {
      "type": [
        "string",
        "null"
      ],
      "description": "Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines."
    },
    "includeAttachments": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Default true"
    }
  },
  "required": [
    "idempotencyKey",
    "messageId",
    "to"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
