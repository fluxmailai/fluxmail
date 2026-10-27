---
title: 'List folders'
description: 'List the folders in a mailbox, with roles such as inbox, sent, drafts, trash, spam and starred.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_folders`

List the folders in a mailbox, with roles such as inbox, sent, drafts, trash, spam and starred.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |

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
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
