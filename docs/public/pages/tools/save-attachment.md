---
title: 'save_attachment'
description: 'Save one attachment as a new file in the attachment folder, instead of returning its content. Give the path relative to the folder. The file mustn''t exist yet: Fluxmail never replaces one. No part of the path may start with a dot. The attachment size limit does not apply.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Save one attachment as a new file in the attachment folder, instead of returning its content. Give the path relative to the folder. The file mustn't exist yet: Fluxmail never replaces one. No part of the path may start with a dot. The attachment size limit does not apply.

## Permissions

Required capabilities: `mail.read` + `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |
| `attachmentId` | Yes | `string` | Opaque attachment ID returned by message metadata Minimum length: 1. Maximum length: 512. |
| `path` | Yes | `string` | New file name, relative to the folder Minimum length: 1. Maximum length: 1024. |

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
    "messageId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "attachmentId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Opaque attachment ID returned by message metadata"
    },
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024,
      "description": "New file name, relative to the folder"
    }
  },
  "required": [
    "messageId",
    "attachmentId",
    "path"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
