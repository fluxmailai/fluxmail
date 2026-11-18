---
title: 'rename_folder'
description: 'Rename a folder in a mailbox. Give the new name on its own, without the parent path: the folder stays under the same parent and keeps its messages and subfolders. The new name must not be one another folder has. In Gmail, where the folder is a label, the labels nested under it are renamed to match. System folders such as Inbox, Sent and Trash can''t be renamed, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs, so use the ID in the result or list the folders again. Message IDs stay the same. Call list_folders first to find the folder ID.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Rename a folder in a mailbox. Give the new name on its own, without the parent path: the folder stays under the same parent and keeps its messages and subfolders. The new name must not be one another folder has. In Gmail, where the folder is a label, the labels nested under it are renamed to match. System folders such as Inbox, Sent and Trash can't be renamed, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs, so use the ID in the result or list the folders again. Message IDs stay the same. Call list_folders first to find the folder ID.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `folder` | Yes | `string` | ID of the folder to rename, as list_folders returns it, or the folder name. Minimum length: 1. Maximum length: 512. |
| `name` | Yes | `string` | New name for the folder itself, without its parent path. For Projects/2025, give 2026 to get Projects/2026. Minimum length: 1. Maximum length: 512. |

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
      "description": "ID of the folder to rename, as list_folders returns it, or the folder name."
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "New name for the folder itself, without its parent path. For Projects/2025, give 2026 to get Projects/2026."
    }
  },
  "required": [
    "folder",
    "name"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
