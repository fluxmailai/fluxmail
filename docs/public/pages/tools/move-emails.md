---
title: 'Move emails'
description: 'Move messages to a folder other than the archive or trash.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`move_emails`

Move messages to a folder other than the archive or trash.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `messageIds` | Yes | array of `string` | None |
| `folder` | Yes | `string` | Destination folder name or ID Minimum length: 1. |

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
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1
    },
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Destination folder name or ID"
    }
  },
  "required": [
    "messageIds",
    "folder"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
