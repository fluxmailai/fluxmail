---
title: 'cancel_scheduled_email'
description: 'Cancel a pending scheduled send by its scheduleId. The draft stays in the Drafts folder, so the content is not lost. Get the scheduleId from send_email or forward_email with sendAt, or from list_scheduled_emails.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Cancel a pending scheduled send by its scheduleId. The draft stays in the Drafts folder, so the content is not lost. Get the scheduleId from send_email or forward_email with sendAt, or from list_scheduled_emails.

## Permissions

Required capabilities: `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `scheduleId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |

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
    "scheduleId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": [
    "scheduleId"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
