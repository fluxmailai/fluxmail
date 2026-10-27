---
title: 'Get email'
description: 'Read one email with its recipients, body and attachment metadata. The body returns at most 50,000 characters, and bodyTruncation reports where each part continues. Use get_email_body to read the rest.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`get_email`

Read one email with its recipients, body and attachment metadata. The body returns at most 50,000 characters, and bodyTruncation reports where each part continues. Use get_email_body to read the rest.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `messageId` | Yes | `string` | Minimum length: 1. |
| `includeHeaders` | No | `boolean` or `null` | Include Message-ID, References, In-Reply-To and other threading headers |
| `bodyFormat` | No | `text` or `html` or `both` or `none` or `null` | None |

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
    "includeHeaders": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Include Message-ID, References, In-Reply-To and other threading headers"
    },
    "bodyFormat": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "text",
            "html",
            "both",
            "none"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "messageId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
