---
title: 'get_delivery_operation'
description: 'Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome.

## Permissions

Required capabilities: `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `operationId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |

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
    "operationId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": [
    "operationId"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
