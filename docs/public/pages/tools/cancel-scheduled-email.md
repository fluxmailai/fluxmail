---
title: 'Cancel scheduled email'
description: 'Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`cancel_scheduled_email`

Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost.

## Permissions

Required capabilities: `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `scheduleId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "scheduleId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": [
    "scheduleId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
