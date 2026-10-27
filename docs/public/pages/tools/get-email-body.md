---
title: 'Get email body'
description: 'Read a bounded portion of one email body. Use nextOffset to continue.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`get_email_body`

Read a bounded portion of one email body. Use nextOffset to continue.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |
| `format` | Yes | `text` or `html` | None |
| `offset` | No | `integer` or `null` | Minimum: 0. |
| `maxChars` | No | `integer` or `null` | Minimum: 1. Maximum: 50000. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        {
          "type": "null"
        }
      ],
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "messageId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "format": {
      "type": "string",
      "enum": [
        "text",
        "html"
      ]
    },
    "offset": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        }
      ]
    },
    "maxChars": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 50000
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "messageId",
    "format"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
