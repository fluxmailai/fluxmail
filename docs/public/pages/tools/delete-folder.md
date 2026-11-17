---
title: 'delete_folder'
description: 'Delete an empty folder from a mailbox. The folder must have no messages and no subfolders: move or trash its mail and delete its subfolders first. In Gmail, where the folder is a label, remove the label from its messages. System folders such as Inbox, Sent and Trash can''t be deleted, and neither can a folder the account settings use as one. Call list_folders first to find the folder ID.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Delete an empty folder from a mailbox. The folder must have no messages and no subfolders: move or trash its mail and delete its subfolders first. In Gmail, where the folder is a label, remove the label from its messages. System folders such as Inbox, Sent and Trash can't be deleted, and neither can a folder the account settings use as one. Call list_folders first to find the folder ID.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `folder` | Yes | `string` | ID of the folder to delete, as list_folders returns it, or the folder name. Minimum length: 1. Maximum length: 512. |

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
    "folder": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "ID of the folder to delete, as list_folders returns it, or the folder name."
    }
  },
  "required": [
    "folder"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
