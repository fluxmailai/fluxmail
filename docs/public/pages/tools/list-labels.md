---
title: 'List labels'
description: 'List the Gmail labels or Outlook categories in a mailbox.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_labels`

List the Gmail labels or Outlook categories in a mailbox.

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
