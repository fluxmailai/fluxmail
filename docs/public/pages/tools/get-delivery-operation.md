---
title: 'Get delivery operation'
description: 'Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`get_delivery_operation`

Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome.

## Permissions

Required capabilities: `mail.send`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | Yes | `string` | Minimum length: 1. |
| `operationId` | Yes | `string` | Minimum length: 1. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 1
    },
    "operationId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "accountId",
    "operationId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
