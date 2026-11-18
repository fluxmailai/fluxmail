---
title: 'create_label'
description: 'Create a Gmail label or an Outlook category in a mailbox. If the mailbox already has one with that name, it is returned unchanged. In Gmail, a name such as Projects/2026 creates a nested label and any missing parent labels, and the label also works as a folder. Gmail refuses names it uses for system labels and folders, such as Inbox, Archive and Starred. A new Outlook category has no color. IMAP mailboxes don''t have labels.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Create a Gmail label or an Outlook category in a mailbox. If the mailbox already has one with that name, it is returned unchanged. In Gmail, a name such as Projects/2026 creates a nested label and any missing parent labels, and the label also works as a folder. Gmail refuses names it uses for system labels and folders, such as Inbox, Archive and Starred. A new Outlook category has no color. IMAP mailboxes don't have labels.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `name` | Yes | `string` | Label or category name. For a nested Gmail label, give the full path, such as Projects/2026. Minimum length: 1. Maximum length: 512. |

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
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Label or category name. For a nested Gmail label, give the full path, such as Projects/2026."
    }
  },
  "required": [
    "name"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
