---
title: 'List scheduled emails'
description: 'List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_scheduled_emails`

List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running.

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
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
