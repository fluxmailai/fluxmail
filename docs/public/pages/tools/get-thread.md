---
title: 'get_thread'
description: 'Read a page of messages in an email thread, with at most 50,000 body characters per page.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Read a page of messages in an email thread, with at most 50,000 body characters per page.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `threadId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |
| `pageSize` | No | `integer` or `null` | Minimum: 1. Maximum: 25. |
| `pageToken` | No | `string` or `null` | Minimum length: 1. Maximum length: 1024. |
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
          "minLength": 1,
          "maxLength": 512
        },
        {
          "type": "null"
        }
      ],
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "threadId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "pageSize": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 25
        },
        {
          "type": "null"
        }
      ]
    },
    "pageToken": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        {
          "type": "null"
        }
      ]
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
    "threadId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
