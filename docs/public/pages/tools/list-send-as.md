---
title: 'list_send_as'
description: 'List the sender addresses available for a mailbox.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

List the sender addresses available for a mailbox.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |

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
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
