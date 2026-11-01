---
title: 'delete_emails'
description: 'Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail''s built-in Google app cannot delete permanently; move their messages to the trash instead.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail's built-in Google app cannot delete permanently; move their messages to the trash instead.

## Permissions

Required capabilities: `mail.delete`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageIds` | Yes | array of `string` | Messages to change, up to 100 IDs |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
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
    "messageIds": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "description": "Messages to change, up to 100 IDs"
    }
  },
  "required": [
    "messageIds"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
