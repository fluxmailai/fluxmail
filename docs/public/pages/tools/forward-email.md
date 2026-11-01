---
title: 'forward_email'
description: 'Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again.

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
