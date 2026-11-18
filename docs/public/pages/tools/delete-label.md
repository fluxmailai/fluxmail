---
title: 'delete_label'
description: 'Delete a Gmail label or an Outlook category from a mailbox. In Gmail, the label is removed from its messages, which stay in the mailbox, and a label with nested labels can''t be deleted until they are. Gmail system labels such as Inbox and Starred can''t be deleted. In Outlook, the category leaves the mailbox''s category list, but messages that have it keep its name. Call list_labels first to find the label ID.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Delete a Gmail label or an Outlook category from a mailbox. In Gmail, the label is removed from its messages, which stay in the mailbox, and a label with nested labels can't be deleted until they are. Gmail system labels such as Inbox and Starred can't be deleted. In Outlook, the category leaves the mailbox's category list, but messages that have it keep its name. Call list_labels first to find the label ID.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `label` | Yes | `string` | ID of the label or category to delete, as list_labels returns it, or its name. Minimum length: 1. Maximum length: 512. |

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
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "ID of the label or category to delete, as list_labels returns it, or its name."
    }
  },
  "required": [
    "label"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
