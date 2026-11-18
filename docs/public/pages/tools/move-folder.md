---
title: 'move_folder'
description: 'Move a folder under another folder, or to the top level of the mailbox. The folder keeps its own name, its messages and its subfolders. Give either the destination as parent or topLevel: true, not both. The destination can''t be the folder itself, one of its subfolders, or the trash, and it can''t already hold a folder with the same name. In Gmail, where the folder is a label, the labels nested under it move with it. System folders such as Inbox, Sent and Trash can''t be moved, and neither can a folder the account settings use as one. Use the folder ID in the result afterwards: in an IMAP mailbox the folder and its subfolders always get new IDs. Message IDs normally stay the same. If one stops working, list the folder again. Call list_folders first to find the folder IDs.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Move a folder under another folder, or to the top level of the mailbox. The folder keeps its own name, its messages and its subfolders. Give either the destination as parent or topLevel: true, not both. The destination can't be the folder itself, one of its subfolders, or the trash, and it can't already hold a folder with the same name. In Gmail, where the folder is a label, the labels nested under it move with it. System folders such as Inbox, Sent and Trash can't be moved, and neither can a folder the account settings use as one. Use the folder ID in the result afterwards: in an IMAP mailbox the folder and its subfolders always get new IDs. Message IDs normally stay the same. If one stops working, list the folder again. Call list_folders first to find the folder IDs.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `folder` | Yes | `string` | ID of the folder to move, as list_folders returns it, or the folder name. Minimum length: 1. Maximum length: 512. |
| `parent` | No | `string` or `null` | ID or name of the folder to move it under. Leave out when topLevel is true. Minimum length: 1. Maximum length: 512. |
| `topLevel` | No | `boolean` or `null` | Set to true to move the folder to the top level of the mailbox. Leave out when parent is given. |

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
      "description": "ID of the folder to move, as list_folders returns it, or the folder name."
    },
    "parent": {
      "description": "ID or name of the folder to move it under. Leave out when topLevel is true.",
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
    "topLevel": {
      "description": "Set to true to move the folder to the top level of the mailbox. Leave out when parent is given.",
      "type": [
        "boolean",
        "null"
      ]
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
