---
title: 'add_labels'
description: 'Add labels, or Outlook categories, to messages.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Add labels, or Outlook categories, to messages.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageIds` | Yes | array of `string` | Messages to change, up to 100 IDs |
| `labels` | Yes | array of `string` | Gmail labels or Outlook categories |

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
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "minItems": 1,
      "maxItems": 100,
      "description": "Messages to change, up to 100 IDs"
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "minItems": 1,
      "maxItems": 100,
      "description": "Gmail labels or Outlook categories"
    }
  },
  "required": [
    "messageIds",
    "labels"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
