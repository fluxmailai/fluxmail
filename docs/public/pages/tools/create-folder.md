---
title: 'create_folder'
description: 'Create a folder in a mailbox. For a subfolder, give the full path with the separator the mailbox already uses in its folder names, such as Projects/2026. Missing parent folders are created too. If the folder already exists, it is returned unchanged. System folder names, including Inbox, Sent and Trash, are rejected. In Gmail, the folder is a label. Call list_folders first to see how the mailbox writes folder paths.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Create a folder in a mailbox. For a subfolder, give the full path with the separator the mailbox already uses in its folder names, such as Projects/2026. Missing parent folders are created too. If the folder already exists, it is returned unchanged. System folder names, including Inbox, Sent and Trash, are rejected. In Gmail, the folder is a label. Call list_folders first to see how the mailbox writes folder paths.

## Permissions

Required capabilities: `mail.organize`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `name` | Yes | `string` | Folder name, or the full path of a subfolder, such as Receipts or Projects/2026. Minimum length: 1. Maximum length: 512. |

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
      "description": "Folder name, or the full path of a subfolder, such as Receipts or Projects/2026."
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
